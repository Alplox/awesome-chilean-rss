import { createInterface } from 'readline';

/**
 * Las flags que activan modo automático. No se activa si --automatic 
 * aparece como valor de otro flag (ej. --id automatic).
 */
const AUTOMATIC_FLAGS = new Set(['--automatic']);

export function isAutomatic() {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (AUTOMATIC_FLAGS.has(args[i])) return true;
    // Saltar valores de flags con argumentos (ej. --id foo)
    if (args[i].startsWith('--') && !args[i].startsWith('--no-')) {
      if (i + 1 < args.length && !args[i + 1].startsWith('--')) {
        i++; // saltar el valor
      }
    }
  }
  return false;
}

async function withReadline(question, callback) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await new Promise(resolve => {
      rl.question(question, answer => {
        resolve(answer);
      });
    }).then(answer => {
      rl.close();
      return callback(answer);
    });
  } finally {
    rl.close();
  }
}

export async function promptUser(question, { defaultYes = true } = {}) {
  if (!process.stdin.isTTY || isAutomatic()) return defaultYes;
  return withReadline(question, answer => {
    const input = answer.trim().toLowerCase();
    const yes = input === 'y' || input === 'yes' || input === 's' || input === 'si';
    if (defaultYes) {
      return input === '' || yes;
    }
    return yes;
  });
}

export async function promptUrl(feedName, feedUrl) {
  if (!process.stdin.isTTY || isAutomatic()) return null;
  return withReadline(`     🔗 URL alternativa para "${feedName}" (${feedUrl}) (enter para omitir): `, answer => {
    return answer.trim() || null;
  });
}

export async function promptStatus(feedName, feedUrl) {
  if (!process.stdin.isTTY || isAutomatic()) return 'no_feed';
  return withReadline(
    `     ⚠️  Estado para "${feedName}" (${feedUrl}): [a]ctive, [o]ffline, [b]roken, [n]o_feed, s[t]ale (enter = no_feed): `,
    answer => {
      const map = { a: 'active', o: 'offline', b: 'broken', n: 'no_feed', t: 'stale' };
      return map[answer.trim().toLowerCase()] || 'no_feed';
    }
  );
}
