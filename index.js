import express from "express";
import fetch from "node-fetch";
import OpenAI from "openai";

const app = express();
app.use(express.json());

const {
  VERIFY_TOKEN,
  WHATSAPP_TOKEN,
  PHONE_NUMBER_ID,
  OPENAI_API_KEY,
  OPENAI_MODEL
} = process.env;

if (!VERIFY_TOKEN || !WHATSAPP_TOKEN || !PHONE_NUMBER_ID || !OPENAI_API_KEY) {
  console.error("Faltan variables de entorno obligatorias.");
}

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// =========================
// Memoria simple por usuario
// =========================
const greeted = new Set();

/**
 * Memoria por usuario:
 * - history: últimas interacciones (para no repetir)
 * - collected: datos detectados (ciudad, tipo puerta, uso, etc.)
 * - lastSeen: timestamp (para limpieza)
 */
const memory = new Map();

const MAX_HISTORY = 8; // mantener el contexto corto
const MEMORY_TTL_MS = 1000 * 60 * 60 * 24 * 3; // 3 días
const CLEANUP_EVERY_MS = 1000 * 60 * 30; // cada 30 min

function getUserState(userId) {
  if (!memory.has(userId)) {
    memory.set(userId, {
      history: [],
      collected: {
        ciudad: null,
        uso: null,       // comunidad | vivienda | empresa | alquiler_turistico | otros
        puerta: null,    // portal | garaje | entrada | interior | otro
        interes: null    // bajo | medio | alto
      },
      lastSeen: Date.now()
    });
  }
  const state = memory.get(userId);
  state.lastSeen = Date.now();
  return state;
}

function pushHistory(state, role, content) {
  state.history.push({ role, content });
  if (state.history.length > MAX_HISTORY) state.history.shift();
}

function cleanupMemory() {
  const now = Date.now();
  for (const [k, v] of memory.entries()) {
    if (now - v.lastSeen > MEMORY_TTL_MS) {
      memory.delete(k);
      greeted.delete(k);
    }
  }
}
setInterval(cleanupMemory, CLEANUP_EVERY_MS).unref();

// =========================
// Helpers WhatsApp payload
// =========================
function extractIncomingText(value) {
  const msg = value?.messages?.[0];
  if (!msg) return null;

  // Solo texto (puedes ampliar a audio/imagen luego)
  const text = msg?.text?.body?.trim();
  if (!text) return null;

  return { from: msg.from, text };
}

// =========================
// Webhook verification
// =========================
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("Webhook verificado correctamente");
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// =========================
// Recibir mensajes
// =========================
app.post("/webhook", async (req, res) => {
  try {
    const entry = req.body?.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;

    const incoming = extractIncomingText(value);
    if (!incoming) return res.sendStatus(200);

    const { from, text } = incoming;
    console.log("Mensaje recibido de", from, ":", text);

    const state = getUserState(from);

    const isFirstTime = !greeted.has(from);
    if (isFirstTime) greeted.add(from);

    // =========================
    // System prompt optimizado
    // =========================
    const systemPrompt = `
Eres Aníbal (IOPARK). Respondes como persona real por WhatsApp en España.
PROHIBIDO decir que eres IA/asistente/bot.
Tono: cercano, directo, profesional, mensajes cortos (1-4 líneas). Nada de párrafos largos.
No repitas preguntas si ya están respondidas en el historial o en "Datos detectados".
puedes consultar informacion en la url https://iopark.es/. Intenta no decir despues del saludo en que puedo ayudarte hoy y evita icono de saludos, solo que nesceitas o en que te puedo ayudar

Producto:
IOPARK es una solución de cerraduras inteligentes IoT con conectividad propia (no depende de WiFi),
más segura frente a ataques típicos a redes WiFi. Prioridad absoluta: apertura con el móvil (app),
incluyendo apertura remota. También permite apertura por código y/o tarjeta (según modelo).
Funciona incluso en zonas de baja cobertura y se instala de forma fácil.

Objetivo de conversación (en orden):
1) Detectar USO: comunidad / vivienda / empresa / coworking / gimnasio / alquiler turístico / hotel / garaje / otro.
2) Detectar CIUDAD (para coordinar instalación/soporte).
3) Detectar TIPO DE PUERTA: portal/entrada, garaje, interior, trastero, oficina, etc.
4) Explicar 2-3 ventajas máximas (móvil remoto + seguridad sin WiFi + instalación fácil) y una pregunta.
5) Si el interés es alto, pedir fotos de la puerta y de la cerradura ctual o propone llamada breve (pedir hora)

Reglas:
- Si el cliente pide “precio”, pide antes 2 datos mínimos (ciudad + tipo de puerta/uso) y da rango orientativo si procede.
- Si menciona “garaje”, enfatiza control de accesos, mandos, altas/bajas, registros (si aplica) y comodidad móvil.
- Si menciona “alquiler turístico/hotel”, enfatiza llaves digitales, accesos temporales y no depender de copiar llaves.
- Si el cliente ya dijo ciudad/puerta/uso, NO lo vuelvas a preguntar. Avanza al siguiente paso.
- Cierra siempre con UNA pregunta concreta y fácil de responder.
`;

    // Resumen/estado para ayudar a no repetir
    const detectedData = `
Datos detectados (si algo es null es que aún falta):
- ciudad: ${state.collected.ciudad}
- uso: ${state.collected.uso}
- puerta: ${state.collected.puerta}
- interes: ${state.collected.interes}
`;

    // Construir mensajes: un mini-contexto + el user actual
    const messages = [
      { role: "system", content: systemPrompt },
      { role: "system", content: detectedData },
      ...state.history,
      { role: "user", content: text }
    ];

    let reply = "";

    try {
      const completion = await openai.chat.completions.create({
        model: OPENAI_MODEL || "gpt-4o-mini",
        temperature: 0.4,
        messages
      });

      reply = completion?.choices?.[0]?.message?.content?.trim() || "";
      if (!reply) throw new Error("Respuesta vacía del modelo");
    } catch (error) {
      console.error("Error OpenAI:", error?.message || error);
      reply =
        "Ahora mismo estoy a tope de consultas 😅\nDime tu ciudad y qué puerta quieres controlar (portal/garaje/interior) y te lo dejo claro en 2 mensajes.";
    }

    // Guardar historial (para evitar repetición)
    pushHistory(state, "user", text);
    pushHistory(state, "assistant", reply);

    // Presentación solo 1 vez (sin duplicar saludo)
    const finalReply = isFirstTime
      ? `Hola, soy Aníbal de IOPARK 👋\n${reply}`
      : reply;

    // Enviar respuesta a WhatsApp
    const response = await fetch(
      `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${WHATSAPP_TOKEN}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          to: from,
          type: "text",
          text: { body: finalReply }
        })
      }
    );

    const data = await response.text();
    console.log("Respuesta WhatsApp:", data);

    return res.sendStatus(200);
  } catch (error) {
    console.error("Error general:", error);
    return res.sendStatus(500);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Servidor iniciado en puerto", PORT));
