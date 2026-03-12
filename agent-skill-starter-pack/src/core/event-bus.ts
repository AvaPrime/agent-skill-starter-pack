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

  constructor(logger?: Logger) {
    this.logger = logger ?? new Logger({ name: 'EventBus' });
    this.emitter.setMaxListeners(100);
  }

  async emit(event: SkillEvent): Promise<void> {
    this.logger.debug({ event }, 'Event emitted');
    this.emitter.emit(event.type, event);
    this.emitter.emit('*', event); // wildcard subscribers
  }

  on(eventType: SkillEventType | '*', handler: EventHandler): void {
    this.emitter.on(eventType, handler);
  }

  off(eventType: SkillEventType | '*', handler: EventHandler): void {
    this.emitter.off(eventType, handler);
  }

  once(eventType: SkillEventType, handler: EventHandler): void {
    this.emitter.once(eventType, handler);
  }

  /** Remove all listeners — useful in tests */
  removeAllListeners(): void {
    this.emitter.removeAllListeners();
  }
}
