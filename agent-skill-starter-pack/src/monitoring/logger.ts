/**
 * @module monitoring/logger
 * @description Structured JSON logger built on Pino.
 * Supports multiple log levels, child loggers, and request tracing.
 */

import pino from 'pino';

export interface LoggerOptions {
  name: string;
  level?: string;
  pretty?: boolean;
}

export class Logger {
  private readonly instance: pino.Logger;

  constructor(options: LoggerOptions) {
    const level = options.level ?? process.env['LOG_LEVEL'] ?? 'info';
    const pretty = options.pretty ?? process.env['NODE_ENV'] === 'development';

    this.instance = pino({
      name: options.name,
      level,
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: {
        level: (label) => ({ level: label }),
      },
      transport: pretty
        ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } }
        : undefined,
      redact: {
        paths: ['password', 'token', 'secret', 'authorization', 'apiKey', 'api_key', 'credentials'],
        censor: '[REDACTED]',
      },
    });
  }

  debug(obj: Record<string, unknown>, msg?: string): void {
    this.instance.debug(obj, msg);
  }

  info(obj: Record<string, unknown>, msg?: string): void {
    this.instance.info(obj, msg);
  }

  warn(obj: Record<string, unknown>, msg?: string): void {
    this.instance.warn(obj, msg);
  }

  error(obj: Record<string, unknown>, msg?: string): void {
    this.instance.error(obj, msg);
  }

  fatal(obj: Record<string, unknown>, msg?: string): void {
    this.instance.fatal(obj, msg);
  }

  child(bindings: Record<string, unknown>): Logger {
    const child = Object.create(this) as Logger;
    (child as unknown as { instance: pino.Logger }).instance = this.instance.child(bindings);
    return child;
  }
}
