// Emits Anki-style Rust log noise on stdout before a marked error result.
process.stdout.write('blocked main thread for 2400ms:\n  File "anki_bridge.py", line 200, in main\n');
process.stdout.write('__ANKI_BRIDGE_RESULT__{"result":null,"error":"auth failed"}\n');
