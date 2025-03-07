/*******************************************************
 * server.js - minimal Node 20 proxy with logs
 * 
 * Logging for:
 *   - inbound requests
 *   - Sourcegraph fetch calls
 *   - SSE chunks from Sourcegraph
 *******************************************************/
const express = require("express");

const app = express();
app.use(express.json());

// Environment variables
const SRC_ENDPOINT = process.env.SRC_ENDPOINT;        // e.g. "https://my-sourcegraph-instance.com"
const SRC_ACCESS_TOKEN = process.env.SRC_ACCESS_TOKEN;
const PORT = process.env.PORT || 5000;

// Helper function for logs
function log(...args) {
  console.log("[LOG]", ...args);
}

// -----------------------------------------------------
// GET /v1/models
// -----------------------------------------------------
app.get("/v1/models", async (req, res) => {
  try {
    log("GET /v1/models => Received request.");

    // Call Sourcegraph
    const url = `${SRC_ENDPOINT}/.api/llm/models`;
    log("GET /v1/models => Forwarding to Sourcegraph:", url);

    const sgResp = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `token ${SRC_ACCESS_TOKEN}`,
        Accept: "application/json",
        "X-Requested-With": "something 1.0",
      },
    });
    log("GET /v1/models => Sourcegraph responded with status:", sgResp.status);

    if (!sgResp.ok) {
      const errText = await sgResp.text();
      log("GET /v1/models => Sourcegraph error body:", errText);
      return res.status(sgResp.status).send(errText);
    }

    const data = await sgResp.json();
    log("GET /v1/models => Sourcegraph JSON data:", data);

    // Transform to OpenAI style
    const result = {
      object: "list",
      data: data.data.map((m) => ({
        id: m.id,
        object: m.object, // usually "model"
        created: m.created,
        owned_by: m.owned_by,
      })),
    };

    log("GET /v1/models => Sending back to client:", result);
    res.json(result);

  } catch (error) {
    log("GET /v1/models => Exception:", error);
    res.status(500).json({ error: "Failed to list models from Sourcegraph" });
  }
});

// -----------------------------------------------------
// POST /v1/chat/completions
// -----------------------------------------------------
app.post("/chat/completions", async (req, res) => {
  try {
    log("POST /v1/chat/completions => Received request body:", req.body);

    // Destructure
    const {
      model,
      messages,
      temperature,
      max_tokens,
      stream,
    } = req.body;

    // Build the request body for Sourcegraph
    const sgBody = {
      model,
      messages,
    };
    if (typeof temperature !== "undefined") {
      sgBody.temperature = temperature;
    }
    if (typeof max_tokens !== "undefined") {
      sgBody.max_tokens = max_tokens;
    }

    var tstream = false;

    // Decide SSE or not
    if (tstream) {
      log("POST /v1/chat/completions => Using streaming SSE");
      sgBody.stream = true;

      // Set SSE headers
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");

      const url = `${SRC_ENDPOINT}/.api/llm/chat/completions`;
      log("POST /v1/chat/completions => Forwarding SSE to Sourcegraph:", url);

      // Request SSE from Sourcegraph
      const sgResp = await fetch(url, {
        method: "POST",
        headers: {
          "Authorization": `token ${SRC_ACCESS_TOKEN}`,
          "Content-Type": "application/json",
          "Accept": "text/event-stream",
          "X-Requested-With": "something 1.0",
        },
        body: JSON.stringify(sgBody),
      });
      log("POST /v1/chat/completions => Sourcegraph SSE status:", sgResp.status);

      if (!sgResp.ok) {
        const errText = await sgResp.text();
        log("POST /v1/chat/completions => Sourcegraph SSE error body:", errText);
        res.status(sgResp.status);
        return res.end(errText);
      }

      // Stream it chunk-by-chunk
      const reader = sgResp.body.getReader();
      const decoder = new TextDecoder();

      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          log("POST /v1/chat/completions => SSE done reading from Sourcegraph");
          break;
        }
        // decode chunk
        const chunkText = decoder.decode(value, { stream: true });

        // LOG the raw chunk text
        log("[SSE chunk from SG]", chunkText);

        // SSE format we return: "data: <line>\n\n"
        const lines = chunkText.split("\n");
        for (const line of lines) {
          if (line.trim()) {
            res.write(`data: ${line}\n\n`);
          }
        }
      }

      // Send final SSE done
      res.write("data: [DONE]\n\n");
      res.end();

    } else {
      log("POST /v1/chat/completions => Non-streaming request");
      const url = `${SRC_ENDPOINT}/.api/llm/chat/completions`;
      log("POST /v1/chat/completions => Forwarding to Sourcegraph:", url);

      const sgResp = await fetch(url, {
        method: "POST",
        headers: {
          "Authorization": `token ${SRC_ACCESS_TOKEN}`,
          "Content-Type": "application/json",
          "X-Requested-With": "something 1.0",
        },
        body: JSON.stringify(sgBody),
      });
      log("POST /v1/chat/completions => Sourcegraph status:", sgResp.status);

      if (!sgResp.ok) {
        const errText = await sgResp.text();
        log("POST /v1/chat/completions => Sourcegraph error body:", errText);
        return res.status(sgResp.status).send(errText);
      }

      const data = await sgResp.json();
      log("POST /v1/chat/completions => Sourcegraph JSON data:", data);

      // Convert Sourcegraph response to OpenAI-like shape
      const nowSec = Math.floor(Date.now() / 1000);
      const result = {
        id: data.id || "temp-id",
        object: "chat.completion",
        created: data.created || nowSec,
        model: data.model,
        usage: data.usage,
        choices: (data.choices || []).map((c, idx) => {
            log("POST /v1/chat/completions => choice", idx, c);
            return ({
                index: idx,
                message: {
                    role: c.message?.role,
                    content: c.message?.content,
                },
                finish_reason: c.finish_reason || "stop",
            });
        }),
      };

      // deep stringify and log
    log("POST /v1/chat/completions => final response to client:", JSON.stringify(result));
      return res.json(result);
    }
  } catch (err) {
    log("POST /v1/chat/completions => exception:", err);
    res.status(500).json({ error: "Failed to create chat completion from Sourcegraph" });
  }
});

// --------------------------------------------
// Start the server
// --------------------------------------------
app.listen(PORT, () => {
  console.log(`[INFO] Node server listening on port ${PORT}`);
  console.log(`[INFO] Forwarding requests to Sourcegraph at ${SRC_ENDPOINT}`);
});
