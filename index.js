const express = require("express");
const cors = require("cors");
const axios = require("axios");
const cheerio = require("cheerio");

const app = express();
const PORT = 3001;

// Middleware
app.use(cors());
app.use(express.json());

// User agent to mimic a real browser
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

// Function to extract full resolution image from Instagram
async function extractInstagramImage(url) {
  try {
    // Extract post ID from URL
    const postIdMatch = url.match(/\/p\/([A-Za-z0-9_-]+)/);
    if (!postIdMatch) {
      throw new Error("Could not extract post ID from URL");
    }
    const postId = postIdMatch[1];

    console.log(`Extracting post ID: ${postId}`);

    // Method 1: Try Instagram's embed API first (most reliable)
    try {
      const embedUrl = `https://www.instagram.com/p/${postId}/embed/`;
      const embedResponse = await axios.get(embedUrl, {
        headers: {
          "User-Agent": USER_AGENT,
          Accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
          Referer: "https://www.instagram.com/",
          "X-Requested-With": "XMLHttpRequest",
        },
        timeout: 10000,
      });

      const embedHtml = embedResponse.data;
      const $embed = cheerio.load(embedHtml);

      // Look for the main image in embed
      const embedImg = $embed('img[src*="scontent"]').first();
      if (embedImg.length > 0) {
        const embedImgSrc = embedImg.attr("src");
        if (
          embedImgSrc &&
          !embedImgSrc.includes("150x150") &&
          !embedImgSrc.includes("240x240")
        ) {
          console.log("Found image via embed method:", embedImgSrc);
          return {
            imageUrl: embedImgSrc,
            fullImageUrl: embedImgSrc,
            highResUrl: embedImgSrc,
            dimensions: extractDimensionsFromUrl(embedImgSrc),
            method: "embed",
            success: true,
          };
        }
      }
    } catch (embedError) {
      console.log("Embed method failed, trying direct method...");
    }

    // Method 2: Direct page request with exact browser simulation
    const response = await axios.get(url, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept-Encoding": "gzip, deflate, br",
        Connection: "keep-alive",
        "Upgrade-Insecure-Requests": "1",
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "none",
        "Sec-Fetch-User": "?1",
        "Cache-Control": "max-age=0",
        "sec-ch-ua":
          '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": '"Windows"',
      },
      timeout: 15000,
    });

    const html = response.data;
    const $ = cheerio.load(html);

    // Method 3: Look for the exact same image that browser displays
    let imageUrl = null;
    let dimensions = { width: 0, height: 0 };
    let method = "unknown";

    // First, try to find the main content image (the one browser shows)
    const mainImages = $('img[src*="scontent"]');
    let bestImage = null;
    let maxScore = 0;

    mainImages.each((i, elem) => {
      const src = $(elem).attr("src");
      const alt = $(elem).attr("alt") || "";
      const className = $(elem).attr("class") || "";

      if (src && !src.includes("stories") && !src.includes("profile")) {
        // Score images based on how likely they are to be the main post image
        let score = 0;
        const dims = extractDimensionsFromUrl(src);

        // Higher score for larger images
        score += (dims.width * dims.height) / 1000000; // Million pixels = 1 point

        // Higher score for square or landscape images (typical post ratios)
        const ratio = dims.width / dims.height;
        if (ratio >= 0.8 && ratio <= 1.25) score += 10; // Square-ish
        if (ratio > 1.25 && ratio <= 2) score += 8; // Landscape

        // Higher score for images with post-related attributes
        if (
          alt.toLowerCase().includes("photo") ||
          alt.toLowerCase().includes("image")
        )
          score += 5;
        if (className.includes("_image") || className.includes("post"))
          score += 5;

        // Penalty for tiny images (likely thumbnails)
        if (dims.width < 400 || dims.height < 400) score -= 20;

        // Bonus for very high resolution
        if (dims.width >= 1080 || dims.height >= 1080) score += 15;

        console.log(
          `Image candidate: ${src.substring(0, 60)}... Score: ${score}, Dims: ${
            dims.width
          }x${dims.height}`
        );

        if (score > maxScore) {
          maxScore = score;
          bestImage = src;
          dimensions = dims;
          method = "main-image-detection";
        }
      }
    });

    if (bestImage) {
      imageUrl = bestImage;
    }

    // Method 4: Extract from Instagram's JSON data structures
    if (!imageUrl) {
      const scriptTags = $("script");
      scriptTags.each((i, elem) => {
        const scriptContent = $(elem).html();

        // Look for window._sharedData or similar Instagram data
        if (
          scriptContent &&
          (scriptContent.includes("window._sharedData") ||
            scriptContent.includes('"display_url"'))
        ) {
          try {
            // Method 4a: window._sharedData
            const sharedDataMatch = scriptContent.match(
              /window\._sharedData\s*=\s*({.*?});/
            );
            if (sharedDataMatch) {
              const sharedData = JSON.parse(sharedDataMatch[1]);
              const entryData =
                sharedData?.entry_data?.PostPage?.[0]?.graphql?.shortcode_media;

              if (entryData) {
                // Get the main display URL (this is what Instagram shows in browser)
                if (entryData.display_url) {
                  imageUrl = entryData.display_url;
                  dimensions = {
                    width: entryData.dimensions?.width || 0,
                    height: entryData.dimensions?.height || 0,
                  };
                  method = "shared-data-display-url";
                  console.log("Found display_url from _sharedData:", imageUrl);
                }

                // Also check display_resources for even higher resolution
                if (
                  entryData.display_resources &&
                  entryData.display_resources.length > 0
                ) {
                  const highestRes = entryData.display_resources.reduce(
                    (max, current) => {
                      return current.config_width * current.config_height >
                        max.config_width * max.config_height
                        ? current
                        : max;
                    }
                  );

                  // Only use if it's significantly higher resolution
                  if (
                    highestRes.config_width > dimensions.width ||
                    highestRes.config_height > dimensions.height
                  ) {
                    imageUrl = highestRes.src;
                    dimensions = {
                      width: highestRes.config_width,
                      height: highestRes.config_height,
                    };
                    method = "shared-data-highest-res";
                    console.log(
                      "Found higher resolution from display_resources:",
                      imageUrl
                    );
                  }
                }
              }
            }

            // Method 4b: Direct JSON parsing for display_url patterns
            if (!imageUrl) {
              const displayUrlMatches = scriptContent.match(
                /"display_url":"([^"]+)"/g
              );
              if (displayUrlMatches) {
                const urls = displayUrlMatches
                  .map((match) => {
                    const urlMatch = match.match(/"display_url":"([^"]+)"/);
                    return urlMatch
                      ? urlMatch[1].replace(/\\u0026/g, "&").replace(/\\/g, "")
                      : null;
                  })
                  .filter(Boolean);

                if (urls.length > 0) {
                  // Get the URL with the best dimensions
                  const urlsWithDims = urls.map((url) => ({
                    url,
                    dims: extractDimensionsFromUrl(url),
                    score:
                      extractDimensionsFromUrl(url).width *
                      extractDimensionsFromUrl(url).height,
                  }));

                  const bestUrl = urlsWithDims.reduce((max, current) => {
                    return current.score > max.score ? current : max;
                  });

                  imageUrl = bestUrl.url;
                  dimensions = bestUrl.dims;
                  method = "json-display-url";
                  console.log("Found display_url from JSON:", imageUrl);
                }
              }
            }
          } catch (e) {
            console.error("Error parsing Instagram JSON data:", e.message);
          }
        }
      });
    }

    // Method 5: Meta tags fallback
    if (!imageUrl) {
      const ogImage = $('meta[property="og:image"]').attr("content");
      const twitterImage = $('meta[name="twitter:image"]').attr("content");
      imageUrl = ogImage || twitterImage;
      if (imageUrl) {
        dimensions = extractDimensionsFromUrl(imageUrl);
        method = "meta-tags";
        console.log("Found image from meta tags:", imageUrl);
      }
    }

    if (!imageUrl) {
      throw new Error("Could not extract image URL from Instagram post");
    }

    // Clean up the URL to match exactly what Instagram serves
    imageUrl = imageUrl.replace(/\\u0026/g, "&").replace(/\\/g, "");

    // Validate and enhance the URL to ensure we get the exact same image
    const urlDimensions = extractDimensionsFromUrl(imageUrl);
    const finalDimensions = dimensions.width > 0 ? dimensions : urlDimensions;

    // Log the extraction details
    console.log("✅ Successfully extracted image:", {
      method,
      url: imageUrl.substring(0, 80) + "...",
      dimensions: finalDimensions,
      isHighRes:
        finalDimensions.width >= 1000 || finalDimensions.height >= 1000,
    });

    return {
      imageUrl,
      fullImageUrl: imageUrl,
      highResUrl: imageUrl,
      dimensions: finalDimensions,
      method,
      postId,
      success: true,
    };
  } catch (error) {
    console.error("Error extracting Instagram image:", error.message);
    throw new Error(`Failed to extract image: ${error.message}`);
  }
}

// Helper function to extract dimensions from URL
function extractDimensionsFromUrl(url) {
  const dimensionMatch = url.match(/(\d+)x(\d+)/);
  if (dimensionMatch) {
    return {
      width: parseInt(dimensionMatch[1]),
      height: parseInt(dimensionMatch[2]),
    };
  }
  return { width: 0, height: 0 };
}

// API endpoint to extract Instagram image
app.post("/api/extract", async (req, res) => {
  try {
    const { url, fullResolution, extractFullImage } = req.body;

    if (!url) {
      return res.status(400).json({ error: "Instagram URL is required" });
    }

    // Validate Instagram URL
    const instagramRegex =
      /^https?:\/\/(www\.)?instagram\.com\/(p|reel|tv)\/([A-Za-z0-9_-]+)\/?/;
    if (!instagramRegex.test(url)) {
      return res.status(400).json({ error: "Invalid Instagram URL format" });
    }

    console.log(`🔍 Extracting EXACT SAME IMAGE as browser shows for: ${url}`);

    const result = await extractInstagramImage(url);

    console.log("✅ Extraction successful:", {
      method: result.method,
      postId: result.postId,
      dimensions: result.dimensions,
      isHighRes:
        result.dimensions.width >= 1000 || result.dimensions.height >= 1000,
      urlPreview: result.imageUrl.substring(0, 100) + "...",
    });

    res.json({
      ...result,
      message: `Extracted using method: ${result.method}`,
      extractedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error("❌ API Error:", error.message);
    res.status(500).json({
      error: error.message,
      success: false,
      timestamp: new Date().toISOString(),
    });
  }
});

// Health check endpoint
app.get("/health", (req, res) => {
  res.json({
    status: "OK",
    message: "Instagram Full-Resolution Image Extractor API",
    version: "1.0.0",
  });
});

// Error handling middleware
app.use((error, req, res, next) => {
  console.error("Unhandled error:", error);
  res.status(500).json({ error: "Internal server error" });
});

// Start server
app.listen(PORT, () => {
  console.log(
    `🚀 Instagram Full-Resolution Backend Server running on http://localhost:${PORT}`
  );
  console.log(`📸 Ready to extract full-quality Instagram images!`);
  console.log(`🔍 Health check: http://localhost:${PORT}/health`);
});
