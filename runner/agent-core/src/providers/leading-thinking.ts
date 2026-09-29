/** Split a provider's leading thinking envelope even across token boundaries.
 * Literal tags later in an answer (including code examples) remain untouched. */
export class LeadingThinkingFilter {
  private pending = '';
  private state: 'prefix' | 'thinking' | 'answer' = 'prefix';
  private closing = '';

  push(text: string): { text: string; thinking: string } {
    this.pending += text;
    let answer = '';
    let thinking = '';
    if (this.state === 'prefix') {
      const candidate = this.pending.trimStart();
      const tags = ['<think>', '<thinking>', '<analysis>'];
      const opening = tags.find((tag) => candidate.startsWith(tag));
      if (opening) {
        this.pending = candidate.slice(opening.length);
        this.closing = opening.replace('<', '</');
        this.state = 'thinking';
      } else if (candidate && !tags.some((tag) => tag.startsWith(candidate))) {
        this.state = 'answer';
      } else { return { text: '', thinking: '' }; }
    }
    if (this.state === 'thinking') {
      const end = this.pending.indexOf(this.closing);
      if (end >= 0) {
        thinking = this.pending.slice(0, end);
        this.pending = this.pending.slice(end + this.closing.length);
        this.state = 'answer';
      } else {
        // Retain only a suffix that could still complete the closing tag.
        let keep = 0;
        for (let n = 1; n < this.closing.length; n++) {
          if (this.pending.endsWith(this.closing.slice(0, n))) keep = n;
        }
        thinking = this.pending.slice(0, this.pending.length - keep);
        this.pending = keep ? this.pending.slice(-keep) : '';
      }
    }
    if (this.state === 'answer') { answer = this.pending; this.pending = ''; }
    return { text: answer, thinking };
  }

  finish(): { text: string; thinking: string } {
    const pending = this.pending;
    this.pending = '';
    // An incomplete opening/closing envelope is never displayed as an answer.
    return this.state === 'answer' || (this.state === 'prefix' && !pending.trim())
      ? { text: pending, thinking: '' } : { text: '', thinking: pending };
  }
}
