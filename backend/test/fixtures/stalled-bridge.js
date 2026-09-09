// Accepts every request, answers none, and never exits on its own: the transport's own deadline is the only
// thing that can end a call made against it. It ignores the end of its input, because a bridge that exits
// when stdin closes dies well inside any deadline a test can set — the exit would then be read as a normal
// one instead of the expiry the tests are trying to prove.
process.stdin.resume();
setInterval(() => {}, 1000);
