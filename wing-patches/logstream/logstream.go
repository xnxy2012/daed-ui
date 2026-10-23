/*
 * SPDX-License-Identifier: AGPL-3.0-only
 */

// Package logstream keeps a ring buffer of recent log lines (fed by a logrus
// hook) and serves them to authenticated clients as Server-Sent Events.
package logstream

import (
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/sirupsen/logrus"
)

const (
	ringSize     = 5000  // general lines
	connRingSize = 10000 // connection records are kept separately so debug noise cannot evict them
)

type item struct {
	seq  uint64
	line string
}

type hub struct {
	mu       sync.Mutex
	seq      uint64
	ring     []item
	connRing []item
	subs     map[chan string]struct{}
	attached map[*logrus.Logger]struct{}
}

var h = &hub{
	subs:     map[chan string]struct{}{},
	attached: map[*logrus.Logger]struct{}{},
}

// noisy debug lines that are emitted continuously and carry no information for the panel.
var noise = []string{
	"converting to graphQL int32",
	"cleanupRoutingHandoffMap",
	"cleanupConnStateMap",
}

func isNoise(line string) bool {
	for _, n := range noise {
		if strings.Contains(line, n) {
			return true
		}
	}
	return false
}

// isConn reports whether the line is a per-connection routing record ("A <-> B dialer=... outbound=...").
func isConn(line string) bool {
	return strings.Contains(line, " <-> ") &&
		(strings.Contains(line, "outbound=") || strings.Contains(line, "dialer="))
}

type hook struct{}

func (hook) Levels() []logrus.Level { return logrus.AllLevels }

// Fire formats the entry with the logger's own formatter, so the stream looks
// exactly like what dae prints on the console.
func (hook) Fire(e *logrus.Entry) error {
	s, err := e.String()
	if err != nil {
		return nil
	}
	s = strings.TrimRight(s, "\r\n")
	// SSE data lines must not contain newlines: split multi-line messages.
	for _, line := range strings.Split(s, "\n") {
		h.push(line)
	}
	return nil
}

// Attach registers the hook on l (once per logger).
func Attach(l *logrus.Logger) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if _, ok := h.attached[l]; ok {
		return
	}
	h.attached[l] = struct{}{}
	l.AddHook(hook{})
}

func trim(r []item, max int) []item {
	if len(r) > max {
		return append([]item(nil), r[len(r)-max:]...)
	}
	return r
}

func (h *hub) push(line string) {
	if isNoise(line) {
		return
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	h.seq++
	it := item{seq: h.seq, line: line}
	if isConn(line) {
		h.connRing = trim(append(h.connRing, it), connRingSize)
	} else {
		h.ring = trim(append(h.ring, it), ringSize)
	}
	for ch := range h.subs {
		select {
		case ch <- line:
		default: // slow consumer: drop instead of blocking the logger
		}
	}
}

func tailOf(r []item, n int) []item {
	if n >= 0 && len(r) > n {
		return r[len(r)-n:]
	}
	return r
}

// subscribe returns up to tail lines of each ring, merged in arrival order, plus a live channel.
func (h *hub) subscribe(tail int) ([]string, chan string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	a, b := tailOf(h.ring, tail), tailOf(h.connRing, tail)
	hist := make([]string, 0, len(a)+len(b))
	i, j := 0, 0
	for i < len(a) || j < len(b) {
		if j >= len(b) || (i < len(a) && a[i].seq < b[j].seq) {
			hist = append(hist, a[i].line)
			i++
		} else {
			hist = append(hist, b[j].line)
			j++
		}
	}
	ch := make(chan string, 1024)
	h.subs[ch] = struct{}{}
	return hist, ch
}

func (h *hub) unsubscribe(ch chan string) {
	h.mu.Lock()
	delete(h.subs, ch)
	h.mu.Unlock()
}

// Handler streams logs as SSE. Wrap it with the authentication middleware:
// requests whose context carries no "user" value are rejected.
func Handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Context().Value("user") == nil {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		fl, ok := w.(http.Flusher)
		if !ok {
			http.Error(w, "streaming unsupported", http.StatusInternalServerError)
			return
		}
		tail := 500
		if v, err := strconv.Atoi(r.URL.Query().Get("tail")); err == nil {
			tail = v
		}

		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache")
		w.Header().Set("X-Accel-Buffering", "no")

		hist, ch := h.subscribe(tail)
		defer h.unsubscribe(ch)
		for _, l := range hist {
			fmt.Fprintf(w, "data: %s\n", l)
		}
		fl.Flush()

		keepalive := time.NewTicker(15 * time.Second)
		defer keepalive.Stop()
		for {
			select {
			case <-r.Context().Done():
				return
			case l := <-ch:
				fmt.Fprintf(w, "data: %s\n", l)
				fl.Flush()
			case <-keepalive.C:
				fmt.Fprint(w, ": ping\n")
				fl.Flush()
			}
		}
	})
}
