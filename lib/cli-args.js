function getArg(args, flag) {
  const idx = args.indexOf(flag);
  return idx !== -1 ? args[idx + 1] : null;
}

function getNumArg(args, flag) {
  const idx = args.indexOf(flag);
  return idx !== -1 ? parseInt(args[idx + 1], 10) : null;
}

export function parseArgs(argv, extraFlags = []) {
  const args = argv.slice(2);
  const result = {
    id: getArg(args, '--id'),
    from: getNumArg(args, '--from'),
    to: getNumArg(args, '--to'),
    limit: getNumArg(args, '--limit'),
    startId: getArg(args, '--start-id'),
    update: args.includes('--update'),
    dryRun: args.includes('--dry-run'),
    automatic: args.includes('--automatic'),
    verbose: args.includes('--verbose'),
  };

  for (const flag of extraFlags) {
    if (flag.type === 'value') {
      result[flag.name] = getArg(args, flag.flag);
    } else if (flag.type === 'num') {
      result[flag.name] = getNumArg(args, flag.flag);
    } else if (flag.type === 'bool') {
      result[flag.name] = args.includes(flag.flag);
    }
  }

  if (args.includes('--id') && (!result.id || result.id.startsWith('--'))) {
    console.error('❌ Error: --id requiere un valor (ID del sitio)');
    process.exit(1);
  }
  if (args.includes('--from') && (result.from === null || isNaN(result.from))) {
    console.error('❌ Error: --from requiere un número válido');
    process.exit(1);
  }
  if (args.includes('--to') && (result.to === null || isNaN(result.to))) {
    console.error('❌ Error: --to requiere un número válido');
    process.exit(1);
  }
  if (args.includes('--start-id') && (!result.startId || result.startId.startsWith('--'))) {
    console.error('❌ Error: --start-id requiere un valor (ID del sitio)');
    process.exit(1);
  }
  if (args.includes('--limit') && (result.limit === null || isNaN(result.limit))) {
    console.error('❌ Error: --limit requiere un número válido');
    process.exit(1);
  }
  if (result.from !== null && result.to !== null && result.from > result.to) {
    console.error('❌ Error: --from no puede ser mayor que --to');
    process.exit(1);
  }

  return result;
}

export function applyFilters(entries, args) {
  let filtered = entries;

  if (args.id) {
    filtered = filtered.filter(e => e.id === args.id);
    if (filtered.length === 0) {
      console.error(`❌ No se encontró ninguna entrada con ID "${args.id}"`);
      process.exit(1);
    }
  }

  if (args.startId) {
    const startIdx = filtered.findIndex(e => e.id === args.startId);
    if (startIdx === -1) {
      console.error(`❌ No se encontró ninguna entrada con ID "${args.startId}"`);
      process.exit(1);
    }
    filtered = filtered.slice(startIdx);
  }

  if (args.from !== null) filtered = filtered.slice(args.from);
  if (args.to !== null) filtered = filtered.slice(0, args.to + 1);
  if (args.limit !== null) filtered = filtered.slice(0, args.limit);

  return filtered;
}

export function applyFiltersSites(sites, args) {
  let filtered = sites;

  if (args.id) {
    filtered = filtered.filter(s => s.id === args.id);
    if (filtered.length === 0) {
      console.error(`❌ No se encontró ningún sitio con ID "${args.id}"`);
      process.exit(1);
    }
  }

  if (args.startId) {
    const startIdx = filtered.findIndex(s => s.id === args.startId);
    if (startIdx === -1) {
      console.error(`❌ No se encontró ningún sitio con ID "${args.startId}"`);
      process.exit(1);
    }
    filtered = filtered.slice(startIdx);
  }

  if (args.from !== null && args.to !== null) {
    filtered = filtered.slice(args.from, args.to + 1);
  } else if (args.from !== null) {
    filtered = filtered.slice(args.from);
  } else if (args.to !== null) {
    filtered = filtered.slice(0, args.to + 1);
  }

  if (args.limit !== null) {
    filtered = filtered.slice(0, args.limit);
  }

  return filtered;
}
