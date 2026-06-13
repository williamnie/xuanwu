const BUS_BUFFER_SIZE = 64;

export type AppEvent = {
  id?: number;
  type: string;
  issueId?: number;
  conversationId?: string;
  projectId?: string;
  threadId?: string;
  turnId?: string;
  method?: string;
  agent_event_type?: string;
  provider?: string;
  raw_method?: string;
  raw_payload?: string;
  command?: string;
  path?: string;
  status?: string;
  text?: string;
  error?: string;
  payload?: string;
  created_at?: string;
};

type Subscriber = {
  events: AppEvent[];
  notify?: () => void;
};

type EventHandler = (event: AppEvent) => void;

export class EventBus {
  #nextID = 0;
  #handlers = new Set<EventHandler>();
  #subscribers = new Map<number, Subscriber>();

  publish(event: AppEvent): void {
    for (const handler of this.#handlers) handler(event);
    for (const subscriber of this.#subscribers.values()) {
      subscriber.events.push(event);
      if (subscriber.events.length > BUS_BUFFER_SIZE) subscriber.events.shift();
      subscriber.notify?.();
      subscriber.notify = undefined;
    }
  }

  subscribe(): EventSubscription {
    const id = this.#nextID;
    this.#nextID += 1;
    this.#subscribers.set(id, { events: [] });
    return new EventSubscription(() => this.#subscribers.get(id), () => this.#subscribers.delete(id));
  }

  subscriberCount(): number {
    return this.#subscribers.size;
  }

  observe(handler: EventHandler): () => void {
    this.#handlers.add(handler);
    return () => {
      this.#handlers.delete(handler);
    };
  }
}

export class EventSubscription {
  #closed = false;

  constructor(
    private readonly getSubscriber: () => Subscriber | undefined,
    private readonly unsubscribe: () => boolean
  ) {}

  close(): void {
    if (this.#closed) return;
    const subscriber = this.getSubscriber();
    this.#closed = true;
    subscriber?.notify?.();
    if (subscriber) subscriber.notify = undefined;
    this.unsubscribe();
  }

  async next(): Promise<AppEvent | undefined> {
    const subscriber = this.getSubscriber();
    if (!subscriber || this.#closed) return undefined;
    const event = subscriber.events.shift();
    if (event) return event;
    return await new Promise((resolve) => {
      subscriber.notify = () => resolve(subscriber.events.shift());
    });
  }
}
