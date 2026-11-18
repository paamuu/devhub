export class MaintenanceGate {
  private active = 0;
  private blocked = false;
  private sealed = false;
  seal() {
    this.sealed = true;
    this.blocked = true;
  }
  private readonly idle = new Set<() => void>();
  async request<T>(
    work: () => Promise<T> | T,
  ): Promise<T | { ok: false; error: { code: string; message: string } }> {
    if (this.blocked)
      return {
        ok: false,
        error: {
          code: "MAINTENANCE",
          message: "正在备份或恢复，请等待操作完成。",
        },
      };
    this.active++;
    try {
      return await work();
    } finally {
      if (--this.active === 0) {
        for (const resolve of this.idle) resolve();
        this.idle.clear();
      }
    }
  }
  async exclusive<T>(work: () => Promise<T>): Promise<T> {
    if (this.blocked) throw new Error("已有备份或恢复操作正在进行。");
    this.blocked = true;
    try {
      if (this.active)
        await new Promise<void>((resolve) => this.idle.add(resolve));
      return await work();
    } finally {
      this.blocked = this.sealed;
    }
  }
}
export const maintenance = new MaintenanceGate();
