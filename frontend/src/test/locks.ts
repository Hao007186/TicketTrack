// jsdom 沒有 navigator.locks；這個假的版本讓同名的鎖依序執行，用來模擬其他分頁
export function installFakeLocks() {
  const names: string[] = [];
  let tail: Promise<unknown> = Promise.resolve();
  const locks = {
    request<T>(name: string, callback: () => Promise<T>): Promise<T> {
      names.push(name);
      const run = tail.then(callback);
      tail = run.catch(() => undefined);
      return run;
    },
  };
  Object.defineProperty(navigator, "locks", { value: locks, configurable: true });
  return {
    names,
    request: locks.request,
    uninstall: () => {
      Reflect.deleteProperty(navigator, "locks");
    },
  };
}
