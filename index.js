// Instagram Downloader Backend - Node.js + Express
// File: server.js

const express = require("express");
const cors = require("cors");
const axios = require("axios");
const cheerio = require("cheerio");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static("public"));

// Rate limiting (simple implementation)
const requestCounts = new Map();
const RATE_LIMIT = 10; // requests per minute
const RATE_WINDOW = 60000; // 1 minute

function rateLimit(req, res, next) {
  const clientIP = req.ip;
  const now = Date.now();

  if (!requestCounts.has(clientIP)) {
    requestCounts.set(clientIP, { count: 1, resetTime: now + RATE_WINDOW });
  } else {
    const clientData = requestCounts.get(clientIP);
    if (now > clientData.resetTime) {
      clientData.count = 1;
      clientData.resetTime = now + RATE_WINDOW;
    } else {
      clientData.count++;
    }

    if (clientData.count > RATE_LIMIT) {
      return res
        .status(429)
        .json({ error: "Rate limit exceeded. Try again later." });
    }
  }

  next();
}

// Utility function to validate Instagram URL
function validateInstagramUrl(url) {
  const instagramRegex =
    /^https?:\/\/(www\.)?instagram\.com\/(p|reel|tv)\/([A-Za-z0-9_-]+)\/?/;
  return instagramRegex.test(url);
}

// Method 1: Extract using Instagram's embed endpoint
async function extractFromEmbed(instagramUrl) {
  try {
    const postId = instagramUrl.match(/\/([A-Za-z0-9_-]+)\/?$/)[1];
    const embedUrl = `https://www.instagram.com/p/${postId}/embed/captioned/`;

    console.log(`Trying embed URL: ${embedUrl}`);

    const response = await axios.get(embedUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
        "Cache-Control": "no-cache",
      },
      timeout: 10000,
    });

    const $ = cheerio.load(response.data);

    // Look for image in various places
    let imageUrl = null;

    // Method 1: Look for img tags with srcset or src
    $("img").each((i, elem) => {
      const srcset = $(elem).attr("srcset");
      const src = $(elem).attr("src");

      if (srcset && srcset.includes(".jpg")) {
        // Extract highest resolution from srcset
        const urls = srcset.split(",").map((s) => s.trim().split(" ")[0]);
        imageUrl = urls[urls.length - 1]; // Usually the highest resolution
        return false;
      } else if (
        src &&
        (src.includes(".jpg") || src.includes(".jpeg")) &&
        !src.includes("profile")
      ) {
        imageUrl = src;
        return false;
      }
    });

    if (!imageUrl) {
      // Look for meta tags
      imageUrl = $('meta[property="og:image"]').attr("content");
    }

    console.log(`Embed extraction result: ${imageUrl}`);
    return imageUrl;
  } catch (error) {
    console.error("Embed extraction error:", error.message);
    throw new Error("Failed to extract from embed: " + error.message);
  }
}

// Method 2: Extract using direct page scraping
async function extractFromPage(instagramUrl) {
  try {
    console.log(`Trying page scraping: ${instagramUrl}`);

    const response = await axios.get(instagramUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
        "Accept-Encoding": "gzip, deflate, br",
        Connection: "keep-alive",
        "Upgrade-Insecure-Requests": "1",
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Cache-Control": "no-cache",
      },
      timeout: 15000,
    });

    const html = response.data;
    console.log(`Page response length: ${html.length}`);

    // Method 1: Look for meta tags first (most reliable)
    const $ = cheerio.load(html);
    let imageUrl = $('meta[property="og:image"]').attr("content");

    if (imageUrl) {
      console.log(`Found og:image: ${imageUrl}`);
      return imageUrl;
    }

    // Method 2: Look for twitter:image
    imageUrl = $('meta[name="twitter:image"]').attr("content");
    if (imageUrl) {
      console.log(`Found twitter:image: ${imageUrl}`);
      return imageUrl;
    }

    // Method 3: Extract from JavaScript data
    const scriptRegex = /window\._sharedData\s*=\s*({.+?});/;
    const match = html.match(scriptRegex);

    if (match) {
      try {
        const jsonData = JSON.parse(match[1]);
        if (jsonData.entry_data && jsonData.entry_data.PostPage) {
          const media = jsonData.entry_data.PostPage[0].graphql.shortcode_media;
          if (media && media.display_url) {
            console.log(`Found from _sharedData: ${media.display_url}`);
            return media.display_url;
          }
        }
      } catch (jsonError) {
        console.log("Failed to parse _sharedData JSON");
      }
    }

    // Method 4: Look for other script tags with image data
    const additionalDataRegex = /"display_url":"([^"]+)"/g;
    const displayUrlMatch = additionalDataRegex.exec(html);
    if (displayUrlMatch) {
      const url = displayUrlMatch[1].replace(/\\u0026/g, "&");
      console.log(`Found display_url: ${url}`);
      return url;
    }

    console.log("No image found in page scraping");
    return null;
  } catch (error) {
    console.error("Page scraping error:", error.message);
    throw new Error("Failed to extract from page: " + error.message);
  }
}

// Method 3: Simple fallback using oEmbed (Instagram's official embed API)
async function extractFromOEmbed(instagramUrl) {
  try {
    console.log(`Trying oEmbed: ${instagramUrl}`);

    const oembedUrl = `https://graph.facebook.com/v12.0/instagram_oembed?url=${encodeURIComponent(
      instagramUrl
    )}&access_token=your_access_token`;

    // Since we don't have access token, try the basic oembed endpoint
    const basicOembedUrl = `https://api.instagram.com/oembed/?url=${encodeURIComponent(
      instagramUrl
    )}`;

    const response = await axios.get(basicOembedUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      },
      timeout: 10000,
    });

    const data = response.data;
    if (data && data.thumbnail_url) {
      console.log(`Found from oEmbed: ${data.thumbnail_url}`);
      return data.thumbnail_url;
    }

    return null;
  } catch (error) {
    console.error("oEmbed error:", error.message);
    // Don't throw error, let other methods try
    return null;
  }
}

// Main extraction function that tries multiple methods
async function extractInstagramImage(instagramUrl) {
  console.log(`Starting extraction for: ${instagramUrl}`);

  const methods = [
    { name: "Page Scraping", func: extractFromPage },
    { name: "Embed", func: extractFromEmbed },
    { name: "oEmbed", func: extractFromOEmbed },
  ];

  const errors = [];

  for (const method of methods) {
    try {
      console.log(`Trying ${method.name} method...`);
      const imageUrl = await method.func(instagramUrl);
      if (imageUrl) {
        console.log(`✓ Success with ${method.name} method: ${imageUrl}`);
        return imageUrl;
      } else {
        console.log(`✗ ${method.name} method returned null`);
      }
    } catch (error) {
      const errorMsg = `${method.name} method failed: ${error.message}`;
      console.log(`✗ ${errorMsg}`);
      errors.push(errorMsg);
    }
  }

  console.log("All extraction methods failed");
  throw new Error(
    `All extraction methods failed. Errors: ${errors.join("; ")}`
  );
}

// Routes
app.get("/", (req, res) => {
  res.json({
    message: "Instagram Downloader API",
    endpoints: {
      "/api/download": "POST - Download Instagram image",
      "/api/extract": "POST - Extract image URL only",
    },
  });
});

// Extract image URL endpoint
app.post("/api/extract", rateLimit, async (req, res) => {
  try {
    const { url } = req.body;

    console.log(`\n=== New extraction request ===`);
    console.log(`URL: ${url}`);
    console.log(`Time: ${new Date().toISOString()}`);
    console.log(`IP: ${req.ip}`);

    if (!url) {
      console.log("❌ No URL provided");
      return res.status(400).json({ error: "URL is required" });
    }

    if (!validateInstagramUrl(url)) {
      console.log("❌ Invalid Instagram URL format");
      return res
        .status(400)
        .json({
          error:
            "Invalid Instagram URL format. Please use: https://www.instagram.com/p/POST_ID/",
        });
    }

    const imageUrl = await extractInstagramImage(url);

    if (!imageUrl) {
      console.log("❌ No image found");
      return res
        .status(404)
        .json({ error: "No image found at the provided URL" });
    }

    console.log(`✅ Success! Image URL: ${imageUrl}`);
    console.log(`=== End extraction request ===\n`);

    res.json({
      success: true,
      imageUrl: imageUrl,
      originalUrl: url,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("❌ Extract error:", error.message);
    console.log(`=== End extraction request (ERROR) ===\n`);

    res.status(500).json({
      error: "Failed to extract image: " + error.message,
      details: process.env.NODE_ENV === "development" ? error.stack : undefined,
    });
  }
});

// Download image endpoint
app.post("/api/download", rateLimit, async (req, res) => {
  try {
    const { url } = req.body;

    if (!url) {
      return res.status(400).json({ error: "URL is required" });
    }

    if (!validateInstagramUrl(url)) {
      return res.status(400).json({ error: "Invalid Instagram URL format" });
    }

    // Extract image URL
    const imageUrl = await extractInstagramImage(url);

    if (!imageUrl) {
      return res
        .status(404)
        .json({ error: "No image found at the provided URL" });
    }

    // Fetch the image
    const imageResponse = await axios.get(imageUrl, {
      responseType: "stream",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
      },
    });

    // Set response headers for download
    const filename = `instagram-image-${Date.now()}.jpg`;
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Content-Type", "image/jpeg");

    // Pipe the image to response
    imageResponse.data.pipe(res);
  } catch (error) {
    console.error("Download error:", error);
    res.status(500).json({
      error: "Failed to download image: " + error.message,
    });
  }
});

// Test endpoint to debug extraction
app.post("/api/test", async (req, res) => {
  try {
    const { url } = req.body;

    if (!url) {
      return res.status(400).json({ error: "URL is required" });
    }

    console.log(`Testing URL: ${url}`);

    // Test basic connectivity
    const testResults = {
      url: url,
      isValidFormat: validateInstagramUrl(url),
      timestamp: new Date().toISOString(),
      methods: {},
    };

    // Test each method individually
    const methods = [
      { name: "Page Scraping", func: extractFromPage },
      { name: "Embed", func: extractFromEmbed },
      { name: "oEmbed", func: extractFromOEmbed },
    ];

    for (const method of methods) {
      try {
        console.log(`Testing ${method.name}...`);
        const result = await method.func(url);
        testResults.methods[method.name] = {
          success: !!result,
          result: result || "No image found",
          error: null,
        };
      } catch (error) {
        testResults.methods[method.name] = {
          success: false,
          result: null,
          error: error.message,
        };
      }
    }

    res.json(testResults);
  } catch (error) {
    res.status(500).json({
      error: "Test failed: " + error.message,
    });
  }
});

// Health check endpoint
app.get("/health", (req, res) => {
  res.json({ status: "OK", timestamp: new Date().toISOString() });
});

// Error handling middleware
app.use((error, req, res, next) => {
  console.error("Server error:", error);
  res.status(500).json({ error: "Internal server error" });
});

// Start server
app.listen(PORT, () => {
  console.log(`Instagram Downloader API running on port ${PORT}`);
  console.log(`Visit http://localhost:${PORT} for API info`);
});

module.exports = app;
