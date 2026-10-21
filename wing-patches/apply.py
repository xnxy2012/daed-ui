#!/usr/bin/env python3
"""Inject the dae log stream into a dae-wing checkout, matching code by anchors
(not line numbers) so it works across wing versions.  Usage: apply.py <wing-dir>"""
import os, re, shutil, sys

wing = sys.argv[1] if len(sys.argv) > 1 else "wing"
here = os.path.dirname(os.path.abspath(__file__))
IMPORT = '\t"github.com/daeuniverse/dae-wing/logstream"\n'


def fail(msg):
    print(f"::error::{msg}")
    sys.exit(1)


def read(p):
    with open(os.path.join(wing, p), encoding="utf-8") as f:
        return f.read()


def write(p, s):
    with open(os.path.join(wing, p), "w", encoding="utf-8") as f:
        f.write(s)


def add_import(s, name):
    if IMPORT.strip() in s:
        return s
    m = re.search(r"^import \(\n", s, re.M)
    if not m:
        fail(f"{name}: no parenthesised import block found")
    return s[: m.end()] + IMPORT + s[m.end():]


if not os.path.isfile(os.path.join(wing, "go.mod")):
    fail("wing submodule is empty (go.mod not found)")

# 1. the package itself
dst = os.path.join(wing, "logstream")
os.makedirs(dst, exist_ok=True)
shutil.copy(os.path.join(here, "logstream", "logstream.go"), os.path.join(dst, "logstream.go"))

# 2. cmd/run.go: attach hook at startup + register /logs next to /graphql
s = read("cmd/run.go")
if "logstream.Handler()" not in s:
    s = add_import(s, "cmd/run.go")
    s, n = re.subn(
        r"(Run:\s*func\(cmd \*cobra\.Command, args \[\]string\) \{\n)",
        r"\1\t\t\tlogstream.Attach(logrus.StandardLogger())\n",
        s,
        count=1,
    )
    if n != 1:
        fail("cmd/run.go: could not find the runCmd Run func")
    s, n = re.subn(
        r'^(\s*)(mux\.Handle\("/graphql",.*\n)',
        r'\1\2\1mux.Handle("/logs", auth(cors.AllowAll().Handler(logstream.Handler())))\n',
        s,
        count=1,
        flags=re.M,
    )
    if n != 1:
        fail('cmd/run.go: could not find mux.Handle("/graphql", ...)')
    write("cmd/run.go", s)

# 3. dae/run.go: re-attach on every reload (dae creates a fresh logrus.Logger)
s = read("dae/run.go")
if "logstream.Attach(log)" not in s:
    s = add_import(s, "dae/run.go")
    s, n = re.subn(r"^(\s*)(log = logrus\.New\(\)\n)", r"\1\2\1logstream.Attach(log)\n", s, flags=re.M)
    if n == 0:
        print("::warning::dae/run.go: no 'log = logrus.New()' found; logs after a config reload may not be captured")
    write("dae/run.go", s)

print("log stream injected into", wing)
