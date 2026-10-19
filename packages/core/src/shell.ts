const SAFE = /^[A-Za-z0-9_@%+=:,./-]+$/;

const quote = (word: string) => (SAFE.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`);

// The command that follows `--` on a yagura command line, as the one shell string yagura runs. One word is a command written as a
// string ("cargo test --workspace") and is used as it is. Several words are an argv the agent's own shell already split
// (`bash -c 'echo "a b"'` arrives as bash, -c, and echo "a b"), so each is quoted to reach yagura's shell as it left the agent's.
export function commandFromArgv(args: string[]): string {
  return args.length === 1 ? args[0]! : args.map(quote).join(" ");
}
