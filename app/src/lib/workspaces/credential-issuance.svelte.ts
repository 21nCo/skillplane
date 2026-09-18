export class CredentialIssuance {
  issuing = $state(false);
  credential = $state<string | null>(null);
  credentialFor = $state<string | null>(null);

  get blocked(): boolean {
    return this.issuing || Boolean(this.credential);
  }

  get blockedReason(): string | undefined {
    if (this.credential) return "Save the pending credential first";
    if (this.issuing) return "A credential is already being issued";
    return undefined;
  }

  begin(): boolean {
    if (this.blocked) return false;
    this.issuing = true;
    return true;
  }

  succeed(credential: string, name: string): void {
    this.credential = credential;
    this.credentialFor = name;
    this.issuing = false;
  }

  fail(): void {
    this.issuing = false;
  }

  acknowledge(): void {
    this.credential = null;
    this.credentialFor = null;
    this.issuing = false;
  }
}
