export class OperationOwner {
  #generation = 0;
  #token = null;

  begin(bookId) {
    this.#token = Object.freeze({ generation: ++this.#generation, bookId });
    return this.#token;
  }

  invalidate() {
    this.#generation += 1;
    this.#token = null;
  }

  currentToken() {
    return this.#token;
  }

  isCurrent(token, bookId = token?.bookId) {
    return token?.generation === this.#generation && token.bookId === bookId;
  }
}
