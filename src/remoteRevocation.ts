export function isRemoteEpochRevoked(keyEpoch: number, revokedThroughEpoch: number): boolean {
  return Number.isInteger(keyEpoch) && keyEpoch > 0 &&
    Number.isInteger(revokedThroughEpoch) && revokedThroughEpoch >= keyEpoch;
}

export class RemoteRevocationAdmissionBarrier {
  private blocked = false;

  get active(): boolean {
    return this.blocked;
  }

  begin(): void {
    this.blocked = true;
  }

  reset(): void {
    this.blocked = false;
  }

  allows(exactDuplicate: boolean): boolean {
    return !this.blocked || exactDuplicate;
  }
}

/**
 * The tombstone is the authority boundary. It must reach durable storage
 * before secrets are deleted so a crash in either step can never restore the
 * revoked epoch.
 */
export async function commitRemoteRevocation(
  keyEpoch: number,
  writeTombstone: (keyEpoch: number) => Promise<void>,
  deleteSecrets: () => Promise<void>,
): Promise<void> {
  if (!Number.isInteger(keyEpoch) || keyEpoch <= 0 || keyEpoch > 0xffff_ffff) {
    throw new Error("remote revocation epoch must be a positive uint32");
  }
  await writeTombstone(keyEpoch);
  await deleteSecrets();
}
