// Network trouble in plain words. The engine passes the RPC's own text through ("failed to get info about account …:
// Error: 429 : max usage reached"); a person needs to know what happened and what to do, not the account address.
const TROUBLE: { test: RegExp; text: string }[] = [
  { test: /\b429\b|max usage|rate.?limit|too many requests/i,
    text: 'The connection to Solana this site uses has hit its usage limit. Try again in a few minutes; if it keeps happening, the site\'s operator needs a new RPC key.' },
  { test: /failed to fetch|fetch failed|rpc unreachable|econnrefused|enotfound|network ?error|timed? ?out/i,
    text: 'Couldn\'t reach Solana. Check your connection, then try again.' },
];
/// The plain explanation for a network failure, or null when the message is about something else.
export const rpcTrouble = (m: string | null | undefined): string | null => (m ? TROUBLE.find((t) => t.test.test(m))?.text ?? null : null);
