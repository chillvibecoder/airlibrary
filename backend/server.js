require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { ImageAnnotatorClient } = require('@google-cloud/vision');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const axios = require('axios');

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

// Initialize Google Cloud Vision
const visionClient = new ImageAnnotatorClient({
    credentials: require('./service-account.json')
});

// Initialize Gemini
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-pro-vision" });

app.use(cors());
app.use(express.json());

// Helper function to extract ISBN from image
async function extractISBN(imageBuffer) {
    try {
        // Try Gemini Vision first
        const image = {
            inlineData: {
                data: imageBuffer.toString('base64'),
                mimeType: 'image/jpeg'
            }
        };
        const result = await model.generateContent([image, "Extract the ISBN number from this image. Return only the ISBN number, nothing else."]);
        const isbn = result.response.text().trim();
        if (isbn.match(/^[\d-]{10,13}$/)) return isbn;

        // Fallback to Google Vision
        const [result2] = await visionClient.textDetection(imageBuffer);
        const text = result2.fullTextAnnotation.text;
        const isbnMatch = text.match(/[\d-]{10,13}/);
        return isbnMatch ? isbnMatch[0] : null;
    } catch (error) {
        console.error('Error extracting ISBN:', error);
        return null;
    }
}

// Helper function to fetch book metadata
async function fetchMetadata(isbn) {
    try {
        const response = await axios.get(`https://www.googleapis.com/books/v1/volumes?q=isbn:${isbn}`);
        if (response.data.items && response.data.items[0]) {
            const book = response.data.items[0].volumeInfo;
            return {
                title: book.title,
                author: book.authors ? book.authors.join(', ') : 'Unknown Author',
                isbn: isbn,
                coverUrl: book.imageLinks?.thumbnail || null
            };
        }
        return null;
    } catch (error) {
        console.error('Error fetching metadata:', error);
        return null;
    }
}

// Process images endpoint
app.post('/api/process-images', upload.fields([
    { name: 'isbnImage', maxCount: 1 },
    { name: 'coverImage', maxCount: 1 }
]), async (req, res) => {
    try {
        if (!req.files['isbnImage'] || !req.files['coverImage']) {
            return res.status(400).json({ error: 'Both ISBN and cover images are required' });
        }

        const isbnImage = req.files['isbnImage'][0].buffer;
        const coverImage = req.files['coverImage'][0].buffer;

        // Extract ISBN
        const isbn = await extractISBN(isbnImage);
        if (!isbn) {
            return res.status(400).json({ error: 'Could not extract ISBN from image' });
        }

        // Fetch book metadata
        const metadata = await fetchMetadata(isbn);
        if (!metadata) {
            return res.status(404).json({ error: 'Book not found' });
        }

        // Convert cover image to base64
        const coverBase64 = coverImage.toString('base64');

        res.json({
            ...metadata,
            coverImage: coverBase64
        });
    } catch (error) {
        console.error('Error processing images:', error);
        res.status(500).json({ error: 'Error processing images' });
    }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
}); 