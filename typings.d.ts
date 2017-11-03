declare module 'clix-logger' {
  interface Logger {
    error(...data: any[]): void;
    log(...data: any[]): void;
    ok(...data: any[]): void;
    print(...data: any[]): void;
    subtle(...data: any[]): void;
    success(...data: any[]): void;
    warn(...data: any[]): void;
  }

  type LogType =
    | 'error'
    | 'log'
    | 'ok'
    | 'print'
    | 'subtle'
    | 'success'
    | 'warn';

  interface LoggerOptions {
    appendTime?: boolean;
    coloredOutput?: boolean;
    quiet?: boolean;
    methods?: {
      [key in LogType]?: {
        muteable?: boolean;
        color?: string;
        token?: string;
      }
    }
  }

  function createLogger(options?: LoggerOptions): Logger;
  export = createLogger;
}

declare module 'expand-tilde' {
  function expandTilde(path: string): string;

  export = expandTilde;
}