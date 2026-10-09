/** Only whole-message control output is silent; explanations quoting these strings remain visible. */
export function isEmptyGroupReply(value: string) {
  const text = value.trim();
  return (
    !text ||
    /^(?:<\|(?:eos|eot_id|endoftext|im_end)\|>\s*)+$/i.test(text) ||
    /^(?:[（(]\s*)?空消息\s*[,，]\s*无需回[应复]\s*(?:[）)])?[。.!！]?$/.test(text)
  );
}
