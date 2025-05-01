import React, { useState } from 'react';
import { Container, Box, Typography, Button, Paper, CircularProgress, Alert } from '@mui/material';
import axios from 'axios';

function App() {
  const [isbnImage, setIsbnImage] = useState(null);
  const [coverImage, setCoverImage] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);

  const handleImageUpload = (event, type) => {
    const file = event.target.files[0];
    if (type === 'isbn') {
      setIsbnImage(file);
    } else {
      setCoverImage(file);
    }
  };

  const handleSubmit = async () => {
    if (!isbnImage || !coverImage) {
      setError('Please select both ISBN and cover images');
      return;
    }

    setLoading(true);
    setError(null);

    const formData = new FormData();
    formData.append('isbnImage', isbnImage);
    formData.append('coverImage', coverImage);

    try {
      const response = await axios.post('http://localhost:5000/api/process-images', formData);
      setResult(response.data);
    } catch (error) {
      setError(error.response?.data?.error || 'Error processing images');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Container maxWidth="md">
      <Box sx={{ my: 4 }}>
        <Typography variant="h4" component="h1" gutterBottom align="center">
          Book Image Processor
        </Typography>

        <Paper sx={{ p: 3, mb: 3 }}>
          <Box sx={{ mb: 2 }}>
            <Button
              variant="contained"
              component="label"
              fullWidth
              sx={{ mb: 1 }}
            >
              Choose ISBN Image
              <input
                type="file"
                hidden
                accept="image/*"
                onChange={(e) => handleImageUpload(e, 'isbn')}
              />
            </Button>
            {isbnImage && (
              <Typography variant="body2" color="text.secondary">
                Selected: {isbnImage.name}
              </Typography>
            )}
          </Box>

          <Box sx={{ mb: 2 }}>
            <Button
              variant="contained"
              component="label"
              fullWidth
              sx={{ mb: 1 }}
            >
              Choose Cover Image
              <input
                type="file"
                hidden
                accept="image/*"
                onChange={(e) => handleImageUpload(e, 'cover')}
              />
            </Button>
            {coverImage && (
              <Typography variant="body2" color="text.secondary">
                Selected: {coverImage.name}
              </Typography>
            )}
          </Box>

          <Button
            variant="contained"
            color="primary"
            onClick={handleSubmit}
            disabled={!isbnImage || !coverImage || loading}
            fullWidth
          >
            {loading ? <CircularProgress size={24} /> : 'Process Images'}
          </Button>
        </Paper>

        {error && (
          <Alert severity="error" sx={{ mb: 2 }}>
            {error}
          </Alert>
        )}

        {result && (
          <Paper sx={{ p: 3 }}>
            <Typography variant="h6" gutterBottom>
              Results
            </Typography>
            <Typography>Title: {result.title}</Typography>
            <Typography>Author: {result.author}</Typography>
            <Typography>ISBN: {result.isbn}</Typography>
            {result.coverImage && (
              <Box sx={{ mt: 2 }}>
                <img
                  src={`data:image/jpeg;base64,${result.coverImage}`}
                  alt="Book Cover"
                  style={{ maxWidth: '100%', height: 'auto' }}
                />
              </Box>
            )}
          </Paper>
        )}
      </Box>
    </Container>
  );
}

export default App; 