/**
 * Phát sự kiện lệnh ra Kafka và RabbitMQ, chỉ khi có cấu hình qua biến môi trường:
 * - `KAFKA_BROKERS` (ví dụ `127.0.0.1:9092`): topic `order-events`, key là mã lệnh.
 * - `RABBITMQ_URL` (ví dụ `amqp://guest:guest@127.0.0.1:5672`): topic exchange `orders`, routing key là tên sự kiện.
 * Không cấu hình thì không làm gì; lỗi khi phát không làm hỏng API (chỉ in ra stderr).
 */
import amqp, { type Channel } from 'amqplib'
import { Kafka, logLevel, type Producer } from 'kafkajs'

export interface OrderEvent {
  event: 'order.created' | 'order.cancelled' | 'order.filled'
  orderId: number
  [key: string]: unknown
}

let kafka: Promise<Producer | undefined> | undefined
let rabbit: Promise<Channel | undefined> | undefined

function kafkaProducer() {
  const brokers = process.env.KAFKA_BROKERS
  if (!brokers) return Promise.resolve(undefined)
  return kafka ??= (async () => {
    const client = new Kafka({ clientId: 'order-api', brokers: brokers.split(','), logLevel: logLevel.NOTHING })
    const admin = client.admin()
    await admin.connect()
    await admin.createTopics({ topics: [{ topic: 'order-events', numPartitions: 3 }] }).catch(() => {})
    await admin.disconnect()
    const producer = client.producer({ allowAutoTopicCreation: false })
    await producer.connect()
    return producer
  })().catch((error) => { console.error('kafka unavailable:', error.message); kafka = undefined; return undefined })
}

function rabbitChannel() {
  const url = process.env.RABBITMQ_URL
  if (!url) return Promise.resolve(undefined)
  return rabbit ??= (async () => {
    const conn = await amqp.connect(url)
    const channel = await conn.createChannel()
    await channel.assertExchange('orders', 'topic', { durable: true })
    return channel
  })().catch((error) => { console.error('rabbitmq unavailable:', error.message); rabbit = undefined; return undefined })
}

/** Khởi tạo kết nối sớm để exchange và topic tồn tại trước khi test tạo tap hoặc đọc. */
export async function initEvents() {
  await Promise.all([kafkaProducer(), rabbitChannel()])
}

export async function publish(event: OrderEvent) {
  const body = JSON.stringify({ ...event, at: new Date().toISOString() })
  const [producer, channel] = await Promise.all([kafkaProducer(), rabbitChannel()])
  await producer?.send({ topic: 'order-events', messages: [{ key: String(event.orderId), value: body, headers: { 'event-type': event.event } }] })
    .catch((error) => console.error('kafka publish failed:', error.message))
  channel?.publish('orders', event.event, Buffer.from(body), { contentType: 'application/json', type: event.event })
}
