// Offline support is a closed grammar, not keyword detection. Every sentence
// must match in full: adding a restriction cannot silently preserve coverage.
const amount = String.raw`\d+(?:[.,]\d{1,2})?`;
const supported = [
  /^Ask me when uncertain$/i,
  new RegExp(`^Buy one ordinary grocery item for CHF ${amount} or less from a shop I use regularly$`, 'i'),
  /^Order our household groceries for delivery$/i,
  new RegExp(`^Keep each order at or below CHF ${amount} including delivery, and keep the total across any seven days at or below CHF ${amount}$`, 'i'),
  new RegExp(`^Replace my worn road-running shoes in size ${amount}$`, 'i'),
  new RegExp(`^Buy only from a specialist sports retailer, only if the order can be returned within [1-9]\\d* days or more, and pay no more than CHF ${amount}$`, 'i'),
  new RegExp(`^The agent may buy clothing for me, up to CHF ${amount} per order, from shops I have used before$`, 'i'),
  /^Pause anything that looks like someone other than me is driving the session$/i,
  new RegExp(`^Buy the [1-9]\\d*-inch monitor I chose, from a seller I have bought from before, for CHF ${amount} or less$`, 'i'),
  /^Do not add anything I did not ask for$/i,
  new RegExp(`^(?:Buy|Order) (?:(?:household )?groceries|one (?:ordinary )?grocery item)(?: for delivery)? for (?:CHF ${amount} or less|exactly CHF ${amount}|between CHF ${amount} and CHF ${amount}|(?:at least|at most|no more than|under|below|over|above) CHF ${amount})$`, 'i'),
];

export function instructionClauses(instruction: string): string[] {
  return instruction.trim().split(/(?<=[.!?;])\s+/).filter(Boolean);
}

export function unsupportedLocalClauses(instruction: string): string[] {
  const clauses=instructionClauses(instruction);
  const matches=clauses.map(clause => {
    const sentence = clause.replace(/[.!?;]$/, '').trim();
    return supported.findIndex(pattern => pattern.test(sentence));
  });
  const unknown=clauses.filter((_,index)=>matches[index]===-1);
  if(unknown.length)return unknown;
  // These are the complete combinations the compiler understands. Two individually
  // supported purchase sentences can conflict (e.g. CHF120 then CHF20); accepting
  // arbitrary composition would lose constraints in the keyword-based compiler.
  const core=matches.at(-1)===0?matches.slice(0,-1):matches;
  const programs=[[1],[2,3],[4,5],[6,7],[8,9],[10]];
  return programs.some(program=>program.length===core.length&&program.every((rule,index)=>rule===core[index]))?[]:clauses;
}
