import WebSocket from 'ws'
import { Subject, fromEvent, Observable } from 'rxjs'
import { Ack } from './ack'
import { map } from 'rxjs/operators'
import { createBackChannel } from './backchannel'
import { noop, once } from '../lang'

const DefaultExclusions: Exclusions = Object.create(null)
export interface Exclusions {
  [channelId: string]: boolean
}
export type AnyJsonPrimitive = string | number | boolean | null
export type AnyJsonObject = { [key: string]: AnyJson }
export type AnyJsonArray = AnyJson[]
export type AnyJson = AnyJsonPrimitive | AnyJsonObject | AnyJsonArray

export { Ack }
export type Acknowledgement = string
export type ChannelGroupName = string
export type ToChannels = string[]
export type Message = AnyJson
export type BackChannelMessage = [ChannelGroupName, ToChannels, Message, Exclusions | null, Acknowledgement | null]
export type LocalMessage = [ToChannels, Message, Exclusions | null, Acknowledgement | null]
export class SocketMessage {
  constructor(public message: Message, public connection: Connection) {}
}

export class Connection {
  channels = new Map<string, Channel>()
  private closing = false
  onPong = fromEvent(this.conn as any, 'pong').pipe(map(() => this._onPong()))
  onMessage = fromEvent(this.conn as any, 'message').pipe(map((x: any) => this._onMessage(x)))
  onClose = fromEvent(this.conn as any, 'close').pipe(map(() => this._onClose()))
  onError = fromEvent<Error>(this.conn as any, 'error').pipe(map((e) => this._onError(e)))

  constructor(public id: string, private conn: WebSocket, private namespace: Namespace) {}

  send(message: Buffer | string, cb?: (...args: any[]) => void): void {
    this.conn.send(message, cb)
  }

  join(name: string): this {
    if (this.closing) {
      return this
    }
    this.channels.set(name, this.namespace.addToChannel(name, this))
    return this
  }

  leave(name: string): this {
    this.channels.delete(name)
    this.namespace.removeFromChannel(name, this)
    return this
  }

  end(): void {
    this.closing = true
    this.conn.close()
  }

  private _dispose() {
    if (!this.conn) {
      return
    }
    for (const x of this.channels.keys()) {
      this.leave(x)
    }
  }

  private _onPong() {
    return this
  }

  private _onError(e: Error) {
    return e
  }

  private _onMessage(message: string | Buffer) {
    return new SocketMessage(JSON.parse(message.toString() ?? 'null'), this)
  }

  private _onClose() {
    this.closing = true
    Promise.resolve().then(() => this._dispose())
    return this
  }
}

export class Channel extends Map<string, Connection> {
  constructor(public name: string, public namespace: Namespace) {
    super()
  }
  send(message: AnyJson, exclusions: Exclusions = {}): Promise<any> {
    return this.namespace.send({ message, channels: [this.name], exclusions })
  }
}

export type NamespaceOptions = {
  backchannel: Subject<BackChannelMessage>
  timeout: number
}

export class Namespace {
  public channels = new Map<string, Channel>()
  private backchannel = new Subject<BackChannelMessage>()
  private backchannelTimeout = 1000
  public onMessage = new Observable<SocketMessage>()
  public onPong = new Observable<Connection>()
  public onError = new Observable<Connection>()
  public onClose = new Observable<Connection>()
  private empty = new Channel('__empty__', this)
  private pendingAcks = new Map<string, Ack>()
  constructor(
    public name: string,
    options: NamespaceOptions = {
      backchannel: createBackChannel(),
      timeout: 1000,
    }
  ) {
    this.backchannel = options.backchannel
    this.backchannelTimeout = options.timeout
  }

  createConnection<T>(id: string, conn: WebSocket, extensions: T): Connection & T {
    return Object.assign(new Connection(id, conn, this), extensions)
  }

  addToChannel(name: string, ...connections: Connection[]): Channel {
    let channel = this.channels.get(name)
    if (!channel) {
      channel = new Channel(name, this)
    }
    for (const conn of connections) {
      channel.set(conn.id, conn)
    }
    return channel
  }

  removeFromChannel(name: string, ...connections: Connection[]): void {
    const channel = this.channels.get(name)
    if (!channel) {
      return
    }
    for (const conn of connections) {
      channel.delete(conn.id)
    }
    if (!channel.size) {
      this.channels.delete(name)
    }
  }

  private sendLocal({
    message,
    channels,
    exclusions,
    ack,
  }: {
    message: Message
    channels: ToChannels
    exclusions: Exclusions | null
    ack: Acknowledgement | null
  }): void {
    const toExclude = exclusions || DefaultExclusions,
      sentTo = new Set<string>()
    let payload = '',
      i = channels.length,
      canAck = false

    const sendAck = ack
      ? once(() => {
          if (canAck) {
            const bcmAck: BackChannelMessage = ['__ack__', [], [ack], null, null]
            this.backchannel.next(bcmAck)
          }
        })
      : noop

    while (i--) {
      const channel = this.channels.get(channels[i]) || this.empty
      for (const connection of channel.values()) {
        if (!sentTo.has(connection.id) && !(connection.id in toExclude)) {
          canAck = true
          connection.send(payload || (payload = JSON.stringify(message)), sendAck)
          sentTo.add(connection.id)
        }
      }
    }
  }

  send({
    message,
    channels = [],
    exclusions,
    ack,
  }: {
    message: Message
    channels?: ToChannels
    exclusions?: Exclusions
    ack?: Acknowledgement
  }): Promise<any> {
    const bcm: BackChannelMessage = [this.name, channels, message, exclusions ?? null, ack ?? null]
    if (ack) {
      const pending = new Ack(this.pendingAcks, ack, this.backchannelTimeout)
      this.backchannel.next(bcm)
      return pending.promise
    }
    this.backchannel.next(bcm)
    return Promise.resolve()
  }
}
