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

// 🔹 1️⃣ Verificación del webhook (GET)
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

// 🔹 2️⃣ Recibir mensajes (POST)
app.post("/webhook", async (req, res) => {
  try {
    const entry = req.body?.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;

    const message = value?.messages?.[0];

    // 👇 Si no es un mensaje entrante, ignoramos
    if (!message) {
      return res.sendStatus(200);
    }

    const from = message.from;
    const text = message.text?.body || "";

    console.log("Mensaje recibido:", text);

    // 🔹 3️⃣ Generar respuesta con OpenAI
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: "Eres el asistente oficial de IOPARK. Responde de forma profesional y clara sobre cerraduras inteligentes."
        },
        {
          role: "user",
          content: text
        }
      ]
    });

    const reply = completion.choices[0].message.content;

    // 🔹 4️⃣ Enviar respuesta por WhatsApp
    await fetch(
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
          text: { body: reply }
        })
      }
    );

    res.sendStatus(200);

  } catch (error) {
    console.error("Error:", error);
    res.sendStatus(500);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Servidor iniciado en puerto", PORT);
});
