type Release = () => void

export class WriteLock {
  private holder: string | null = null
  private queue: Array<{ holder: string; resolve: (release: Release) => void }> = []

  async acquire(holder: string): Promise<Release> {
    if (this.holder === null) {
      this.holder = holder
      return () => this.release()
    }
    return new Promise<Release>(resolve => {
      this.queue.push({ holder, resolve })
    })
  }

  tryAcquire(holder: string): Release | null {
    if (this.holder !== null) return null
    this.holder = holder
    return () => this.release()
  }

  inspect(): { held: boolean; holder: string | null } {
    return { held: this.holder !== null, holder: this.holder }
  }

  private release(): void {
    const next = this.queue.shift()
    if (next) {
      this.holder = next.holder
      next.resolve(() => this.release())
    } else {
      this.holder = null
    }
  }
}
