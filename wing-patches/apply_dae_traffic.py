#!/usr/bin/env python3
"""Make dae's eBPF-offloaded TCP flows report traffic *while they run*.

Upstream only accounts the bytes of an offloaded TCP session once, when the
session ends, so the dashboard shows 0 speed (and flat totals) during transfers.
This patch samples the session's tcp_info byte counters once per loop iteration
(~1s) and records the delta immediately; the final accounting only records what
is still unreported, so totals stay exact.

Usage: apply_dae_traffic.py <dae-core-dir>   (anchor based; skips if it does not match)"""
import os, re, sys

root = sys.argv[1] if len(sys.argv) > 1 else "wing/dae-core"
path = os.path.join(root, "control", "tcp_offload_linux.go")


def skip(msg):
    print(f"::warning::dae traffic patch skipped: {msg}")
    sys.exit(0)


if not os.path.isfile(path):
    skip(f"{path} not found (this dae version has no eBPF TCP offload; nothing to fix)")

s = open(path, encoding="utf-8").read()
if "flushLiveTraffic" in s:
    print("dae traffic patch already applied")
    sys.exit(0)

steps = []


def sub(pattern, repl, label, flags=re.M):
    global s
    s, n = re.subn(pattern, repl, s, count=1, flags=flags)
    if n != 1:
        skip(f"anchor not found: {label}")
    steps.append(label)


# 1. session fields
sub(
    r"^(\taccounted\s+atomic\.Bool\n)",
    r"""\1
	// Live traffic accounting: the recorders and how many rx bytes (per side)
	// were already reported while the session was running.
	leftRecord       func(int64)
	rightRecord      func(int64)
	reportedLeftRx   atomic.Int64
	reportedRightRx  atomic.Int64
""",
    "struct fields",
)

# 2. keep the recorders in the session
sub(
    r"(\n\t\trightRxBase:\s+rightRxBase,\n)",
    r"""\1		leftRecord:  leftRecord,
		rightRecord: rightRecord,
""",
    "constructor",
)

# 3. flush at the 1s guard cadence inside Run
sub(
    r"^(\t\t\tlastGuard = time\.Now\(\)\n)",
    r"\1\t\t\ts.flushLiveTraffic()\n",
    "Run loop",
)

# 4. final accounting only records what is still unreported
sub(
    r"^(\tleftRx, rightRx, err := session\.Run\(ctx\)\n)",
    r"\1\tleftRx, rightRx = session.unreportedTraffic(leftRx, rightRx)\n",
    "final accounting",
)

# 5. new methods
s = s.rstrip("\n") + '''

// flushLiveTraffic records the bytes the kernel moved since the previous call.
// Left (client) receiving is upload, right (egress) receiving is download.
// Called from Run's goroutine only.
func (s *tcpRelayOffloadSession) flushLiveTraffic() {
	if s.leftRecord == nil && s.rightRecord == nil {
		return
	}
	l, r, err := s.rxDeltas()
	if err != nil {
		return // transient or sockets already closed; final accounting covers it
	}
	if d := l - s.reportedLeftRx.Load(); d > 0 {
		s.reportedLeftRx.Store(l)
		if s.rightRecord != nil {
			s.rightRecord(d)
		}
	}
	if d := r - s.reportedRightRx.Load(); d > 0 {
		s.reportedRightRx.Store(r)
		if s.leftRecord != nil {
			s.leftRecord(d)
		}
	}
}

// unreportedTraffic subtracts what flushLiveTraffic already recorded from the
// session's final rx deltas.
func (s *tcpRelayOffloadSession) unreportedTraffic(leftRx, rightRx int64) (int64, int64) {
	leftRx -= s.reportedLeftRx.Load()
	rightRx -= s.reportedRightRx.Load()
	if leftRx < 0 {
		leftRx = 0
	}
	if rightRx < 0 {
		rightRx = 0
	}
	return leftRx, rightRx
}
'''
open(path, "w", encoding="utf-8").write(s)
print("dae traffic patch applied:", ", ".join(steps))
