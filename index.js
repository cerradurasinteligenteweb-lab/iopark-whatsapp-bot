import express from "express";
import fetch from "node-fetch";
import OpenAI from "openai";

const app = express();
app.use(express.json());

const {
  VERIFY_TOKEN,
  WHATSAPP_TOKEN,
  PHONE_NUMBER_ID,
  OPENAI_API_KEY
} = process.env;

const openai = new OpenAI({
  apiKey: OPENAI_API_KEY
});

//  Memoria simple para saber si ya se presentó
const greeted = new Set();

//  Verificación del webhook
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("Webhook verificado correctamente");
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

//  Recepción de mensajes
app.post("/webhook", async (req, res) => {
  try {
    const entry = req.body?.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;
    const message = value?.messages?.[0];

    if (!message) {
      return res.sendStatus(200);
    }

    const from = message.from;
    const text = message.text?.body || "";

    console.log("Mensaje recibido:", text);

    //  Detectar si es la primera vez que escribe
    const isFirstTime = !greeted.has(from);
    if (isFirstTime) greeted.add(from);

    //  Generar respuesta IA
    let reply = "";

    try {
      const completion = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content: `
Eres Aníbal, fundador de IOPARK (cerraduras inteligentes IoT en España).
Hablas en primera persona como si estuvieras escribiendo directamente por WhatsApp.

Nunca digas que eres un asistente o IA.

Objetivo:
1. Detectar si es comunidad, vivienda, empresa o alquiler turístico.
2. Preguntar ciudad si no la ha dicho.
3. Preguntar tipo de puerta (portal, garaje, entrada, interior).
4. Explicar ventajas brevemente.
5. Si hay interés real, ofrecer llamada personal.

No repitas datos que ya haya dado el cliente.
Sé breve y claro.
`
          },
          {
            role: "user",
            content: text
          }
        ]
      });

      reply = completion.choices[0].message.content;

    } catch (error) {
      console.error("Error OpenAI:", error?.message);
      reply = "Ahora mismo estoy atendiendo varias consultas. Si quieres, dime ciudad y tipo de puerta y te llamo personalmente.";
    }

    //  Presentación solo la primera vez
    const finalReply = isFirstTime
      ? `Hola, soy Aníbal de IOPARK 👋\n${reply}`
      : reply;

    //  Enviar respuesta por WhatsApp
const response = await fetch(
  `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`,
  {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${WHATSAPP_TOKEN}`,
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
console.log("Respuesta de WhatsApp:", data);

    res.sendStatus(200);

  } catch (error) {
    console.error("Error general:", error);
    res.sendStatus(500);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Servidor iniciado en puerto", PORT);
});
