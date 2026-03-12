/**
 * @module core/event-bus
 * @description Lightweight typed event bus for skill lifecycle events.
 * Supports in-process subscribers and optional Kafka forwarding.
 */

import { EventEmitter } from 'events';
import { SkillEvent, SkillEventType } from './types';
import { Logger } from '../monitoring/logger';

export type EventHandler = (event: SkillEvent) => Promise<void> | void;

export class EventBus {
  private readonly emitter = new EventEmitter();
  private readonly logger: Logger;
  private readonly handlerWrappers = new WeakMap<
    EventHandler,
    Map<string, (event: SkillEvent) => void>
  >();

  constructor(logger?: Logger) {
    this.logger = logger ?? new Logger({ name: 'EventBus' });
    this.emitter.setMaxListeners(100);
  }

  emit(event: SkillEvent): void {
    this.logger.debug({ event }, 'Event emitted');
    this.emitter.emit(event.type, event);
    this.emitter.emit('*', event); // wildcard subscribers
  }

  on(eventType: SkillEventType | '*', handler: EventHandler): void {
    const wrapper = this.getWrapper(eventType, handler);
    this.emitter.on(eventType, wrapper);
  }

  off(eventType: SkillEventType | '*', handler: EventHandler): void {
    const key = String(eventType);
    const map = this.handlerWrappers.get(handler);
    const wrapper = map?.get(key);
    if (!wrapper) return;
    this.emitter.off(eventType, wrapper);
  }

  once(eventType: SkillEventType, handler: EventHandler): void {
    const wrapper = this.getWrapper(eventType, handler);
    this.emitter.once(eventType, wrapper);
  }

  /** Remove all listeners — useful in tests */
  removeAllListeners(): void {
    this.emitter.removeAllListeners();
  }

  private getWrapper(
    eventType: SkillEventType | '*',
    handler: EventHandler,
  ): (event: SkillEvent) => void {
    const key = String(eventType);
    const existing = this.handlerWrappers.get(handler)?.get(key);
    if (existing) return existing;

    const wrapper = (event: SkillEvent): void => {
      try {
        const out = handler(event);
        void Promise.resolve(out).catch((err: unknown) => {
          this.logger.warn(
            { err: err instanceof Error ? err.message : String(err) },
            'Event handler failed',
          );
        });
      } catch (err: unknown) {
        this.logger.warn(
          { err: err instanceof Error ? err.message : String(err) },
          'Event handler threw',
        );
      }
    };

    const map =
      this.handlerWrappers.get(handler) ??
      new Map<string, (event: SkillEvent) => void>();
    map.set(key, wrapper);
    this.handlerWrappers.set(handler, map);
    return wrapper;
  }
}
