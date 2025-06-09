const axios = require("axios");
const cheerio = require("cheerio");

async function extractInstagramImage(url) {
  try {
    // Fetch Instagram post page with headers to mimic a browser
    const response = await axios.get(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko)" +
          " Chrome/114.0.0.0 Safari/537.36",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
      },
    });

    // Verify content-type is HTML
    if (!response.headers["content-type"].includes("text/html")) {
      throw new Error(
        `Unexpected content-type: ${response.headers["content-type"]}`
      );
    }

    const html = response.data;
    const $ = cheerio.load(html);

    // Find the script tag with window._sharedData JSON
    let sharedDataScript = null;
    $("script").each((i, el) => {
      const scriptContent = $(el).html();
      if (scriptContent && scriptContent.includes("window._sharedData")) {
        sharedDataScript = scriptContent;
      }
    });

    if (!sharedDataScript) {
      throw new Error("Could not find window._sharedData script tag.");
    }

    // Extract JSON from window._sharedData assignment
    const jsonMatch = sharedDataScript.match(
      /window\._sharedData\s*=\s*({[\s\S]*});/
    );

    if (!jsonMatch) {
      throw new Error("Could not extract JSON data from script.");
    }

    let sharedData;
    try {
      sharedData = JSON.parse(jsonMatch[1]);
    } catch (err) {
      throw new Error("Failed to parse JSON from window._sharedData: " + err);
    }

    // Navigate the JSON to find the post media data
    const media = sharedData.entry_data.PostPage?.[0]?.graphql?.shortcode_media;

    if (!media) {
      throw new Error("Could not find media data in sharedData.");
    }

    // Extract the main image URL of the post
    const displayUrl = media.display_url;

    return displayUrl;
  } catch (err) {
    console.error("Error extracting Instagram image:", err.message);
    return null;
  }
}

// Example usage
(async () => {
  const instagramPostUrl = "https://www.instagram.com/p/CuNfJ2FrL7Z/"; // Replace with your Instagram post URL
  const imageUrl = await extractInstagramImage(instagramPostUrl);

  if (imageUrl) {
    console.log("Image URL:", imageUrl);
  } else {
    console.log("Failed to extract image URL.");
  }
})();
