"use strict";

const { sendRequest } = require("../transport/http");
const protocol = require("../protocols/gemini");

async function describeImages(provider, parsed) {
  const body = protocol.anthropicToGeminiContents(parsed);
  const url = provider.baseUrl + provider.basePath + "/" + provider.model + ":generateContent?key=" + provider.apiKey;

  const resp = await sendRequest(url, "POST", {}, body);

  if (resp.status !== 200) {
    return "";
  }

  try {
    const gr = JSON.parse(resp.body);
    const parts = gr.candidates?.[0]?.content?.parts || [];
    return parts.map((p) => p.text || "").join("").trim();
  } catch {
    return "";
  }
}

function stripImagesAndInjectDescription(parsed, imageDescription) {
  if (!parsed.messages) return;

  for (const msg of parsed.messages) {
    if (!Array.isArray(msg.content)) continue;

    const newContent = [];
    const userTextParts = [];
    let hasImage = false;

    for (const block of msg.content) {
      if (block.type === "image") {
        hasImage = true;
      } else if (block.type === "text") {
        userTextParts.push(block.text);
      } else {
        newContent.push(block);
      }
    }

    if (hasImage) {
      const userText = userTextParts.join("\n");
      let imageText;
      if (imageDescription) {
        imageText = userText
          ? userText + "\n\nL'utente ha caricato un'immagine. Ecco la sua descrizione dettagliata:\n" + imageDescription
          : imageDescription;
      } else {
        imageText = userText
          ? userText + "\n\n[Immagine non analizzabile]"
          : "Immagine caricata";
      }
      newContent.unshift({ type: "text", text: imageText });
    }

    if (newContent.length > 0) {
      msg.content = newContent;
    }
  }
}

function hasImages(parsed) {
  for (const msg of parsed.messages || []) {
    if (Array.isArray(msg.content) && msg.content.some((c) => c.type === "image")) {
      return true;
    }
  }
  return false;
}

module.exports = { describeImages, stripImagesAndInjectDescription, hasImages };
