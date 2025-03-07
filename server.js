/*******************************************************
 * server.js - minimal Node 20 proxy wrapping Cody
 * 
 * Logging for:
 *   - inbound requests
 *   - Cody fetch calls
 *   - SSE chunks from Cody
 *******************************************************/
const express = require("express");

const app = express();
app.use(express.json());

// Environment variables (Placeholders)
const CODY_ENDPOINT = process.env.CODY_ENDPOINT || "https://your-cody-instance.com";
const CODY_ACCESS_TOKEN = process.env.CODY_ACCESS_TOKEN || "your-cody-access-token";
const PORT = process.env.PORT || 5000;

// Helper function for logging
function log(...args) {
  console.log("[LOG]", ...args);
}

// -----------------------------------------------------
// GET /v1/models
// -----------------------------------------------------
app.get("/v1/models", async (req, res) => {
  try {
    log("GET /v1/models => Received request.");

    const url = `${CODY_ENDPOINT}/.api/llm/models`;
    log("GET /v1/models => Forwarding to Cody:", url);

    const response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `token ${CODY_ACCESS_TOKEN}`,
        Accept: "application/json",
        "X-Requested-With": "proxy-wrapper 1.0",
      },
    });

    log("GET /v1/models => Cody response status:", response.status);

    if (!response.ok) {
      const errText = await response.text();
      log("GET /v1/models => Error response:", errText);
      return res.status(response.status).send(errText);
    }

    const data = await response.json();
    log("GET /v1/models => Cody JSON data:", data);

    const formattedData = {
      object: "list",
      data: data.data.map((model) => ({
        id: model.id,
        object: model.object,
        created: model.created,
        owned_by: model.owned_by,
      })),
    };

    log("GET /v1/models => Sending response:", formatted);
    res.json(formatted);

  } catch (error) {
    log("GET /v1/models => Exception:", error);
    res.status(500).json({ error: "Internal server error." });
  }
});

// Chat Completion Endpoint
app.post("/chat/completions", async (req, res) => {
  try {
    log("POST /v1/chat/completions => Request body:", req.body);

    const { model, messages, temperature, max_tokens, stream } = req.body;

    const codyRequest = { model, messages, temperature, max_tokens, stream };

    const url = `${CODY_ENDPOINT}/.api/llm/chat/completions`;

    if (stream) {
        log("POST /v1/chat/completions => Streaming mode active");

        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");

        const codyResponse = await fetch(url, {
        method: "POST",
        headers: {
            Authorization: `token ${CODY_ACCESS_TOKEN}`,
            Accept: "text/event-stream",
            "X-Requested-With": "proxy 1.0",
        },
        body: JSON.stringify({
            model,
            messages,
            temperature,
            max_tokens,
            stream: true,
        }),
        });

        log("POST /v1/chat/completions => Cody SSE status:", codyResponse.status);

        if (!codyResponse.ok) {
        const errText = await codyResponse.text();
        log("POST /v1/chat/completions => SSE Error:", errText);
        return res.status(codyResponse.status).send(errText);
        }

        const reader = codyResponse.body.getReader();
        const decoder = new TextDecoder();

        while (true) {
        const { value, done } = await reader.read();
        if (done) {
            log("[SSE] Cody stream ended.");
            break;
        }

        const chunkText = decoder.decode(value, { stream: true });
        log("[SSE chunk from Cody]", chunkText);
        res.write(chunkText);
        }

        res.end();

    } else {
      log("POST /v1/chat/completions => Non-streaming request");

      const url = `${CODY_ENDPOINT}/.api/llm/chat/completions`;
      const response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `token ${CODY_ACCESS_TOKEN}`,
          "Content-Type": "application/json",
          "X-Requested-With": "something 1.0",
        },
        body: JSON.stringify({ model, messages, temperature, max_tokens }),
      });

      log("POST /v1/chat/completions => Cody response status:", response.status);

      if (!response.ok) {
        const errText = await response.text();
        log("POST /v1/chat/completions => Cody error:", errText);
        return res.status(response.status).send(errText);
      }

      const data = await response.json();

      const nowSec = Math.floor(Date.now() / 1000);
      const result = {
        id: data.id || "temp-id",
        object: "chat.completion",
        created: data.created || nowSec,
        model: data.model,
        usage: data.usage,
        choices: data.choices.map((c, idx) => ({
          index: idx,
          message: c.message,
          finish_reason: c.finish_reason || "stop",
        })),
      };

      log("POST /v1/chat/completions => Final response to client:", JSON.stringify(result));
      res.json(result);
    }
  } catch (error) {
    log("POST /v1/chat/completions => Exception:", error);
    res.status(500).json({ error: "Internal server error processing chat completion" });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`[INFO] Proxy server running on port ${PORT}`);
  console.log(`[INFO] Forwarding requests to Cody at ${CODY_ENDPOINT}`);
});
