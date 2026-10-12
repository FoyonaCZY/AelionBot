// Phrases that only say the Bot is not speaking. Kept specific so real answers never match.
const QUIET_CN =
  '保持(?:沉默|静默|安静)|沉默|静默|潜水|' +
  '不(?:再|多)?(?:发言|说话|出声|吭声|插话|接话|回复|回应|作答|打扰|重复|赘述|补充|说了|回了|接了)|' +
  '(?:无需|不(?:需要|用|必))我?(?:发言|回复|回应|作答|补充)|' +
  '(?:没有|暂无|无)(?:新的?|其他|更多|别的|要|可以)?(?:补充|要说的|可说的)';
const QUIET_EN =
  "(?:i(?:['’]m| am|['’]ll| will)? )?(?:stay(?:s|ing)? (?:quiet|silent)|remain(?:s|ing)? silent|silent|silence|" +
  'not (?:speaking|replying|responding|commenting)|no (?:reply|response|comment|need to reply)|nothing (?:new )?to add)';
// A declaration clause: optional subject, time or connective words, the quiet phrase, optional particles.
const DECLARATION = new RegExp(
  '^(?:(?:我|本\\s*bot|这次|这轮|本轮|此轮|这里|此处|暂时|目前|先|就|也|那|那么|所以|因此|还是|继续|选择|决定|[，,\\s])*' +
    `(?:${QUIET_CN})(?:了|啦|吧|呢|中|一下|这轮|本轮)*|${QUIET_EN})$`,
  'i',
);
// Stage directions such as （不发言）, [no reply] or *stays quiet*.
const WRAPPED = /^(?:[（(【[]\s*([^（）()【】[\]]{1,40}?)\s*[）)】\]]|(\*{1,2}|_)\s*([^*_]{1,40}?)\s*\2)$/;
// A clause that only says others already covered it, e.g. "B 已经回答了" or "问题已被回答".
const COVERED =
  /^[^，,：:；;。.!！?？]{0,24}(?:已经?|都|早就?)(?:被)?(?:回答|答|说|讲|解释|提到|覆盖|说明)(?:过|了|完|清楚|得很?(?:完整|清楚|全面|详细)|到位)*$|^\w[\w\s]{0,24}(?:already|has|have)\s+(?:answered|covered|said|explained)\b[^.!?]*$/i;
// "这部分我已经说明了" may report the Bot's own work, so only others covering it counts as a reason.
const covered = (clause: string) => COVERED.test(clause) && !/我|\bi\b/i.test(clause);
// Anything that adds a point keeps the message visible.
const ADDS_SOMETHING = /[?？@]|但|不过|只是|然而|提醒|注意|建议|另外|风险|\b(?:but|however|note)\b/i;
const TRAILING = /[\s。.!！~～…]+$/;
const SELF = /我|决定|选择|就|先|也|这轮|本轮|此轮|这次|发言|说话|插话|接话|沉默|静默|出声|吭声|\bi\b/i;

const strip = (clause: string) => clause.trim().replace(TRAILING, '');
const directive = (clause: string): boolean => {
  const wrapped = WRAPPED.exec(clause.trim());
  if (wrapped) return announcesSilence((wrapped[1] ?? wrapped[3]).trim());
  return DECLARATION.test(strip(clause));
};
// Split on sentence punctuation, keeping a bracketed stage direction as one clause.
const clausesOf = (text: string) =>
  (text.match(/[（(【[][^（）()【】[\]]*[）)】\]]|(\*{1,2}|_)[^*_\n]*\1|[^，,：:；;。.!！\n（(【[*_]+/g) || [])
    .map((part) => part.trim().replace(TRAILING, ''))
    .filter(Boolean);

/**
 * A whole message whose only content is "I am not speaking": （不发言）, 保持沉默。, or a
 * declaration with a short "already covered" reason such as 决定不发言，B 已经回答了。
 */
function announcesSilence(text: string): boolean {
  if (!text || text.length > 80 || ADDS_SOMETHING.test(text)) return false;
  if (directive(text)) return true;
  const clauses = clausesOf(text);
  if (clauses.length < 2) return false;
  let declared = false;
  for (const clause of clauses) {
    // Next to other text, a bare quiet phrase must be about the Bot: "如果用户取消，不回复" stays visible.
    if (directive(clause) && (WRAPPED.test(clause) || SELF.test(clause))) declared = true;
    else if (!covered(clause)) return false;
  }
  return declared;
}

/** Only whole-message control output is silent; explanations quoting these strings remain visible. */
export function isEmptyGroupReply(value: string) {
  const text = value.trim();
  return (
    !text ||
    /^(?:<\|(?:eos|eot_id|endoftext|im_end)\|>\s*)+$/i.test(text) ||
    /^(?:[（(]\s*)?空消息\s*[,，]\s*无需回[应复]\s*(?:[）)])?[。.!！]?$/.test(text) ||
    announcesSilence(text)
  );
}
