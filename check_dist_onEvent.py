"""Runs AFTER v2.8.6 reload (12:54) still show ZERO adapter events. So
ctx.onEvent isn't reaching our code OR our calls aren't firing.

Check the actual call sites: are the emitStructured calls inside execute() even
reached? The init one is right after emitInit. Add a probe: check whether OUR
dist/execute.js has the onEvent wiring (built output)."""
import re

src = open(r"C:\Users\darre\projects\paperclip-adapter-openrouter\dist\server\execute.js", encoding="utf-8").read()
print("onEvent occurrences in dist:", len(re.findall(r"onEvent", src)))
i = src.find("emitStructured")
print(src[i:i+700])
