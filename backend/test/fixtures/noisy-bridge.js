// Emits Anki-style Rust log noise on stdout before a marked success result.
process.stdout.write('blocked main thread for 1305ms:\n  File "anki_bridge.py", line 200, in main\n');
process.stdout.write('  File "anki_bridge.py", line 183, in invoke\n');
process.stdout.write('__ANKI_BRIDGE_RESULT__{"result":{"required":"NORMAL_SYNC"},"error":null}\n');
