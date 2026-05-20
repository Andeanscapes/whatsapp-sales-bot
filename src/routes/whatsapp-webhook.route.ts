import { createHmac, timingSafeEqual } from 'crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { env } from '../config/env.js';
import { getSkills } from '../services/skill-loader.js';
import { isProcessed, markProcessed } from '../services/dedupe-service.js';
import { processMessage } from '../services/response-engine.js';
import { sendText, sendImageUrl } from '../services/whatsapp-client.js';
import { recordImageSend } from '../services/media-service.js';
import { sendAlert } from '../services/alert-service.js';
import { addMessage } from '../services/conversation-store.js';

type RequestWithRawBody = FastifyRequest & { rawBody?: Buffer };

function verifySignature(rawBody: Buffer, signatureHeader: string, secret: string): boolean {
  const expected = `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
  try {
    return timingSafeEqual(Buffer.from(expected), Buffer.from(signatureHeader));
  } catch {
    return false;
  }
}

const messageSchema = z.object({
  from: z.string(),
  id: z.string(),
  type: z.string(),
  text: z.object({ body: z.string() }).optional(),
});

const webhookPayloadSchema = z.object({
  object: z.string(),
  entry: z.array(z.object({
    id: z.string(),
    changes: z.array(z.object({
      value: z.object({
        messaging_product: z.string().optional(),
        messages: z.array(messageSchema).optional(),
      }).passthrough(),
      field: z.string(),
    })),
  })),
}).passthrough();

interface ExtractedMessage {
  from: string;
  id: string;
  text: string;
  timestamp: string;
}

function extractMessages(body: unknown): ExtractedMessage[] | null {
  const parsed = webhookPayloadSchema.safeParse(body);
  if (!parsed.success) return null;

  const result: ExtractedMessage[] = [];
  for (const entry of parsed.data.entry) {
    for (const change of entry.changes) {
      const messages = change.value?.messages;
      if (!messages) continue;
      for (const m of messages) {
        if (m.type !== 'text') continue;
        result.push({ from: m.from, id: m.id, text: m.text?.body ?? '', timestamp: '' });
      }
    }
  }
  return result.length > 0 ? result : null;
}

export async function whatsappWebhookRoutes(app: FastifyInstance, opts: { db: Database.Database }): Promise<void> {
  const db = opts.db;

  app.addContentTypeParser<Buffer>('application/json', { parseAs: 'buffer' }, function (_req, body, done) {
    (_req as RequestWithRawBody).rawBody = body;
    try {
      done(null, JSON.parse(body.toString('utf8')));
    } catch (err) {
      done(err as Error, undefined);
    }
  });

  app.get('/webhooks/whatsapp', async (req, reply) => {
    const query = req.query as Record<string, string>;
    const mode = query['hub.mode'];
    const token = query['hub.verify_token'];
    const challenge = query['hub.challenge'];

    if (mode === 'subscribe' && token === env.WHATSAPP_VERIFY_TOKEN) {
      return reply.type('text/plain').send(challenge);
    }
    return reply.code(403).send('Forbidden');
  });

  app.post('/webhooks/whatsapp', async (req, reply) => {
    const signature = req.headers['x-hub-signature-256'];
    const rawBody = (req as RequestWithRawBody).rawBody;
    if (!rawBody || typeof signature !== 'string' || !verifySignature(rawBody, signature, env.WHATSAPP_APP_SECRET)) {
      return reply.code(403).send({ error: 'Invalid signature' });
    }

    reply.code(200).send({ ok: true });

    const messages = extractMessages(req.body);
    if (!messages) return;

    for (const msg of messages) {
      if (isProcessed(db, msg.id)) continue;
      markProcessed(db, msg.id);

      try {
        const result = await processMessage({ db, customerPhone: msg.from, message: msg.text, messageId: msg.id });

        if (result.shouldSendReply) {
          await sendText(msg.from, result.reply);

          addMessage(db, {
            customer_phone: msg.from,
            direction: 'outbound',
            message_type: 'text',
            body: result.reply,
            created_at: new Date().toISOString(),
          });
        }

        if (result.shouldSendImage) {
          const skills = getSkills();
          const image = skills.media.images[0];
          if (image && image.value !== 'REPLACE_WITH_PUBLIC_IMAGE_URL') {
            await sendImageUrl(msg.from, image.value, image.caption);
            recordImageSend(db, msg.from, image.id);
          }
        }

        if (result.shouldAlertOwner) {
          const conversation = db.prepare('SELECT * FROM conversations WHERE customer_phone = ?').get(msg.from) as Record<string, unknown> | undefined;
          await sendAlert({
            customerPhone: msg.from,
            score: result.leadScore,
            intent: 'lead',
            message: msg.text,
            name: String(conversation?.collected_name ?? 'unknown'),
            date: String(conversation?.collected_date ?? 'unknown'),
            people: String(conversation?.collected_people ?? 'unknown'),
            transport: String(conversation?.collected_transport_need ?? 'unknown'),
          }, db);
        }
      } catch (err) {
        req.log.error({ err, phone: msg.from }, 'Failed to process webhook message');
      }
    }
  });
}
