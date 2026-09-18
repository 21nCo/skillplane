export class CredentialIssuance {
  issuing = $state(false);
  credential = $state<string | null>(null);
  credentialFor = $state<string | null>(null);
  #generation = 0;

  get blocked(): boolean {
    return this.issuing || Boolean(this.credential);
  }

  get blockedReason(): string | undefined {
    if (this.credential) return "Save the pending credential first";
    if (this.issuing) return "A credential is already being issued";
    return undefined;
  }

  begin(): number | false {
    if (this.blocked) return false;
    this.issuing = true;
    this.#generation += 1;
    return this.#generation;
  }

  succeed(token: number, credential: string, name: string): void {
    if (token !== this.#generation) return;
    this.credential = credential;
    this.credentialFor = name;
    this.issuing = false;
  }

  fail(token: number): void {
    if (token !== this.#generation || !this.issuing) return;
    this.issuing = false;
  }

  acknowledge(): void {
    this.credential = null;
    this.credentialFor = null;
    this.issuing = false;
  }
}
