/**
 * What a sentence keeps on one line.
 *
 * A short paragraph that wraps in even lines (`text-wrap: balance`), and in
 * Chinese on the connect page only at the sentence's own pauses (`word-break:
 * keep-all`, `features/pairing/styles/connect.scss`), breaks at its spaces. A
 * space is then also where a command would come apart ("pairfob | pair"), an
 * English phrase quoted from the terminal, or a number from its unit
 * ("14 | 位"). Those spaces are made non-breaking here, as the sentence is
 * drawn, so the copy tables stay plain text.
 *
 * English breaks between words as it always did, except after a number that
 * counts what follows ("14 | characters") and inside what the reader types or
 * reads off the computer letter for letter.
 */
const HAN = /[⺀-鿿]/;
const NBSP = " ";
/** The commands to run, and the line the terminal prints: one thing each, in any language. */
const VERBATIM = /pairfob (?:pair|doctor)|Press Enter to pair/g;

export function keepPhrases(text: string): string {
  const whole = text.replace(VERBATIM, phrase => phrase.replaceAll(" ", NBSP))
    // A number and the unit or noun it counts.
    .replace(/(?<=\d) (?=[\p{L}])/gu, NBSP);
  if (!HAN.test(whole)) return whole;
  // A run of Latin words inside a Chinese sentence reads as one name.
  return whole.replace(/(?<=[\x21-\x7e]) (?=[\x21-\x7e])/g, NBSP);
}
