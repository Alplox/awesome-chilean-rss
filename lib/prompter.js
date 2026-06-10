import { createInterface } from 'readline';

export function isAutomatic() {
  return process.argv.includes('--automatic');
}

export async function promptUser(question, { defaultYes = true } = {}) {
  if (!process.stdin.isTTY || isAutomatic()) return defaultYes;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(question, answer => {
      rl.close();
      const input = answer.trim().toLowerCase();
      const yes = input === 'y' || input === 'yes' || input === 's' || input === 'si';
      if (defaultYes) {
        resolve(input === '' || yes);
      } else {
        resolve(yes);
      }
    });
  });
}

export async function promptUrl(feedName, feedUrl) {
  if (!process.stdin.isTTY || isAutomatic()) return null;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(`     🔗 URL alternativa para "${feedName}" (${feedUrl}) (enter para omitir): `, answer => {
      rl.close();
      resolve(answer.trim() || null);
    });
  });
}

export async function promptStatus(feedName, feedUrl) {
  if (!process.stdin.isTTY || isAutomatic()) return 'no_feed';
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(
      `     ⚠️  Estado para "${feedName}" (${feedUrl}): [a]ctive, [o]ffline, [b]roken, [n]o_feed, s[t]ale (enter = no_feed): `,
      answer => {
        rl.close();
        const map = { a: 'active', o: 'offline', b: 'broken', n: 'no_feed', t: 'stale' };
        resolve(map[answer.trim().toLowerCase()] || 'no_feed');
      }
    );
  });
}
