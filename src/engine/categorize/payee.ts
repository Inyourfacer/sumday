/**
 * Bank descriptions are noisy: "SQ *BLUE BOTTLE COFFEE #1234 OAKLAND CA",
 * "POS PURCHASE TST* JOE'S PIZZA 11/04", "AMAZON.COM*AB12CD3EF". Cleaning them
 * makes rules simpler and lists readable.
 */

// Processor and card-network prefixes, stripped repeatedly from the start.
const PREFIXES = [
  /^(pos|debit card|check ?card|visa|recurring)( purchase| debit| payment)?\s+/i,
  /^purchase( authorized on \d{1,2}\/\d{1,2})?\s+/i,
  /^(sq|tst|pp|sp|py|ckc|dd|ic|par|bt|fs|wpy|sms|zsk)\s?\*\s*/i,
  /^paypal\s?\*\s*/i,
  /^ach\s+(debit|credit|withdrawal|deposit)\s+/i,
];

// Noise at the end: card numbers, store numbers, dates, reference codes.
const SUFFIXES = [
  /\s+(x+|\*+)\d{2,}$/i, // card number XXXX1234 / ****1234
  /\s+(card|acct)\s*#?\s*\d+$/i,
  /\s+\d{1,2}\/\d{1,2}(\/\d{2,4})?$/, // date 11/04 or 11/04/26
  /\s*#\s*\d+(\s+[A-Za-z .'-]+)?$/, // store #1234, optionally followed by "CITY ST"
  /\s+(store|str)\s*#?\s*\d+$/i,
  /\s+\d{4,}$/, // long reference number
];

export function cleanPayee(raw: string): string {
  let text = raw.replace(/\s+/g, " ").trim();
  for (let changed = true; changed; ) {
    changed = false;
    for (const re of PREFIXES) {
      const next = text.replace(re, "");
      if (next !== text && next.trim() !== "") {
        text = next.trim();
        changed = true;
      }
    }
  }
  for (let changed = true; changed; ) {
    changed = false;
    for (const re of SUFFIXES) {
      const next = text.replace(re, "");
      if (next !== text && next.trim() !== "") {
        text = next.trim();
        changed = true;
      }
    }
  }
  // "AMAZON.COM*AB12CD3EF" → "AMAZON.COM": drop a trailing *code with digits.
  text = text.replace(/\*(?=[A-Z0-9]*\d)[A-Z0-9]{4,}$/i, "").trim();
  text = text.replace(/[\s*#,-]+$/, "").trim();
  return toDisplayCase(text || raw.trim());
}

/** All-caps bank text → "Title Case"; mixed-case text is left alone. */
function toDisplayCase(text: string): string {
  if (/[a-z]/.test(text)) return text;
  return text.toLowerCase().replace(/(^|[\s/&(-])([a-z])/g, (_, sep: string, ch: string) => sep + ch.toUpperCase());
}

/** A comparison key: case- and punctuation-insensitive. */
export function payeeKey(text: string): string {
  return text
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .trim();
}
