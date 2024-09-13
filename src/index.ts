/*******************************Imports***********************************/
import express, { Request, Response, NextFunction } from 'express';
import { ExifTool } from 'exiftool-vendored';
import multer from 'multer';
import path from 'path';
import fs, { promises as fsPromises } from 'fs';
import cors from 'cors';
import { spawn } from 'child_process';
import os from 'os';
import archiver from 'archiver';
import { v4 as uuidv4 } from 'uuid';
import { ImageWithMetadata } from './imageWithMetadata';
import { Shape } from './shapes'; 
import { Readable } from 'stream';
import tmp from 'tmp';

/****************************Interfaces***********************************/
interface SessionData {
    images: ImageWithMetadata[];
    expiry: number;
}
// Define interface
interface CustomRequest extends Request {
    sessionId?: string; // Add sessionId
}

/****************************Conf/Variable***********************************/
const app = express();
const PORT = process.env.PORT || 3000;
const exiftool = new ExifTool();

// Cors conf
const corsOptions = {
    origin: (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
        const allowedOrigins = (process.env.CORS_ORIGIN || 'http://localhost:4200').split(',');

        if (!origin || allowedOrigins.indexOf(origin) !== -1) {
            callback(null, true);
        } else {
            callback(new Error('Not allowed by CORS'));
        }
    },
    optionsSuccessStatus: 200
};

// Multer conf
const upload = multer({ dest: os.tmpdir() });


app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors(corsOptions));

// Expired time
const sessionExpiryTime = 900000; //15 min

// In-memory storage for session data
const sessionData: { [key: string]: SessionData } = {};


/***********test*********/
/*
// Middleware to test incoming requests
app.use((req: Request, res: Response, next: NextFunction) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
    console.log('Encabezados:', req.headers);
    console.log('Cuerpo:', req.body);
    next();
});*/

/*******************************API***********************************/
// Endpoint to test backend
app.get('/test', (req, res) => {
  res.json({ message: 'Hello world' });
});

// Endpoint to create a new session
app.post('/api/start-session', (req, res) => {
    const sessionId = uuidv4();
    sessionData[sessionId] = {
        images: [],  // Start array empty
        expiry: Date.now() + sessionExpiryTime  // Establecer tiempo de expiración
    };
    console.log("New session -> "+ sessionId);
    res.json({ sessionId });
});

// Endpoint to clear session data
app.post('/api/end-session', checkSession, (req: CustomRequest, res) => {
    const sessionId = req.sessionId as string; 
    delete sessionData[sessionId];
    console.log("Delete session -> " + sessionId);

    res.status(200).json({ message: 'Session ended and data cleared successfully' });
});

// Endpoint check session alive/ping
app.post('/api/ping-session', checkSession, (req: CustomRequest, res) => {
    const sessionId = req.sessionId as string; 
    sessionData[sessionId].expiry = Date.now() + sessionExpiryTime;

    res.status(200).json({ message: 'Session extended successfully' });
});

// Endpoint to upload images
app.post('/api/upload-images', checkSession, upload.array('images'), async (req: CustomRequest, res: Response) => {
    try {
        const files = req.files as Express.Multer.File[];
        const sessionId = req.sessionId as string;

        await addImages(sessionId, files);
        res.status(200).json({ message: 'Images uploaded successfully' });
    } catch (error) {
        console.error('Error adding images:', error);
        res.status(500).json({ error: 'Failed to add images' });
    }
});

// Endpoint to process video and store images in session data
app.post('/api/process-video', checkSession, upload.array('files'), async (req: CustomRequest, res: Response) => {
    const frameRates = JSON.parse(req.body.frameRates);
    const files = req.files as Express.Multer.File[];
    const sessionId = req.sessionId as string;

    try {
        for (let i = 0; i < files.length; i++) {
            console.log("Processing file " + i);
            const videoPath = files[i].path;
            const frameRate = frameRates[i];
            console.log("Take max FPS -> ");
            const maxFrameRate = await getMaxFrameRate(videoPath);
            console.log(maxFrameRate);
            console.log("Processing Video to Images");
            const outputImages = await processVideo(videoPath, frameRate, maxFrameRate, i);
            console.log("Ending Video to Images");

            // Convert buffers to Multer files
            const tempFiles = buffersToMulterFiles(sessionId, outputImages, i);

            // Add images to the session
            await addImages(sessionId, tempFiles);
        }

        res.status(200).json({ message: 'Video processed and images stored successfully' });

    } catch (error) {
        console.error('Error processing video files:', error);
        res.status(500).json({ error: 'Error processing video files.' });
    }
});

// Endpoint to get a single image by ID
app.get('/api/image/:id', checkSession, async (req: CustomRequest, res: Response) => {
    const { id } = req.params;
    const sessionId = req.sessionId as string;

    const session = sessionData[sessionId];
    const imageWithMetadata = session.images.find(image => image.id === id);

    // If image dont exist, return error
    if (!imageWithMetadata) {
        res.status(404).send('Imagen no encontrada');
        return;
    }
    const filePath = imageWithMetadata.file.path;
    const imageName = `image-${imageWithMetadata.id}.png`;

    // Configure answer to get a download
    res.download(filePath, imageName, (err) => {
        if (err) {
            console.error('Error to send archive:', err);
            res.status(500).send('Error to send archive');
        }
    });
});

// Endpoint to get images
app.get('/api/images', checkSession, async (req: CustomRequest, res: Response) => {
    const { pageNumber } = req.query;
    const sessionId = req.sessionId as string;
    const page = parseInt(pageNumber as string, 10);
    const pageSize = 10;

    const session = sessionData[sessionId];
    const totalImages = session.images.length;
    
    // Calculate range for images
    const start = (page - 1) * pageSize;
    const end = Math.min(start + pageSize, totalImages);

    // If Dont have images
    if (start >= totalImages) {
        const archive = archiver('zip', { zlib: { level: 9 } });
        res.attachment('images.zip');
        archive.pipe(res);
        archive.finalize(); // Zip Empty
        return;
    }

    const imagesToZip = session.images.slice(start, end);

    // Create ZIP file with images
    const archive = archiver('zip', { zlib: { level: 9 } });
    res.attachment('images.zip');
    
    archive.pipe(res);
    
    imagesToZip.forEach((imageWithMetadata, index) => {
        const filePath = imageWithMetadata.file.path;
        const imageName = `image-${start + index}-${imageWithMetadata.id}.png`; // Incluye el ID en el nombre del archivo
        archive.file(filePath, { name: imageName });
    });

    archive.finalize();
});

// Endpoint to get all images
app.get('/api/all-images', checkSession, async (req: CustomRequest, res: Response) => {
    const sessionId = req.sessionId as string;
    const session = sessionData[sessionId];
  
    const archive = archiver('zip', {
        zlib: { level: 9 }
    });

    // Configure HTTP dowload Zip
    res.attachment('images.zip');

    // Check errors
    archive.on('error', (err) => {
    console.error('Error creating archive:', err);
    res.status(500).send('Error creating archive');
    });

    // Pipe archive data to the response
    archive.pipe(res);

    if (session.images && session.images.length > 0) {
        session.images.forEach(image => {
            const filePath = image.file.path;
            const imageName = `image-${image.id}.png`;

            // Add file to zip
            archive.file(filePath, { name: imageName });
        });
    }
    archive.finalize();
});

// Endpoint to get total number of images
app.get('/api/number-pages-total-images', checkSession, upload.none(), async (req: CustomRequest, res: Response) => {
    try {
        const sessionId = req.sessionId as string;
        const session = sessionData[sessionId];

        const totalImages = session.images.length;

        res.status(200).json({ totalImages });
    } catch (error) {
        console.error('Error getting total images:', error);
        res.status(500).json({ error: 'Failed to get total images' });
    }
});

// Endpoint to delete image
app.delete('/api/delete-image/:id', checkSession, (req: CustomRequest, res: Response) => {
    const sessionId = req.sessionId as string;
    const session = sessionData[sessionId];
    const imageId = req.params.id;

    // Filter images to get all image with no imageId
    session.images = session.images.filter(image => image.id !== imageId);
    res.status(200).json({ message: 'Image deleted successfully' });
});

// Endpoint to add metadata to image and store in session
app.post('/api/add-metadata', checkSession, upload.none(), async (req: CustomRequest, res: Response) => {
    const { id, jsonMetadata } = req.body;
    const sessionId = req.sessionId as string;
    const session = sessionData[sessionId];
    if (!id || !jsonMetadata) {
        return res.status(400).send('Image id and metadata are required.');
    }

    try {
        const imageIndex = session.images.findIndex(image => image.id === id);

        if (imageIndex !== -1) {
            const imagePath = session.images[imageIndex].file.path;

            if (fs.existsSync(imagePath)) {
                // Write on tag UserComment, even if jsonMetadata is empty
                await exiftool.write(imagePath, { UserComment: jsonMetadata });
                console.log('UserComment written successfully');
                // Update session data with new metadata
                session.images[imageIndex].metadata = jsonMetadata ? JSON.parse(jsonMetadata) : {};
                console.log('Session metadata updated successfully');

                res.status(200).json({ message: 'Metadata updated successfully' });
            } else {
                console.error("The specified image path does not exist.");
                res.status(400).json({ error: 'The specified image path does not exist.' });
            }
        } else {
            console.error('Image not found in session data');
            res.status(404).json({ error: 'Image not found in session data' });
        }
    } catch (error) {
        console.error('Error embedding metadata in image:', error);
        res.status(500).json({ error: 'Error embedding metadata in image.' });
    }
});

// Endpoint to export a image
app.get('/export-image/:id/:format', checkSession, async (req: CustomRequest, res: Response) => {
    const { id, format } = req.params;
    const sessionId = req.sessionId as string;
    const session = sessionData[sessionId];

    // Search session
    const imagesWithMetadata = session.images.find(image => image.id === id);

    if (!imagesWithMetadata) {
        res.status(404).send('Imagen not found');
        return;
    }

    if (format === 'yolo') {
        // Zip name
        res.attachment(`images_yolo.zip`);
        await exportAsYOLO(imagesWithMetadata, res);
    } else {
        res.status(400).send('Formato not supported');
    }
});

// Endpoint to export a image
app.get('/export-all-images/:format', checkSession, async (req: CustomRequest, res: Response) => {
    const { format } = req.params;
    const sessionId = req.sessionId as string;
    const session = sessionData[sessionId];

    // Search session
    const imagesWithMetadata = session.images;

    if (imagesWithMetadata.length === 0) {
        res.status(404).send('Imagen not found');
        return;
    }

    if (format === 'yolo') {
        // Zip name
        res.attachment(`images_yolo.zip`);
        await exportAllAsYOLO(imagesWithMetadata, res);
    } else {
        res.status(400).send('Formato not supported');
    }
});

app.listen(PORT, () => {
    console.log(`Backend server start port ${PORT}`);
});

/*******************************FUNCTIONS***********************************/

// Middleware to check session ID
function checkSession(req: CustomRequest, res: Response, next: NextFunction) {
    // Extract header
    const sessionId = req.headers['x-session-id'] as string | undefined;

    // Check if sessionid exist 
    if (!sessionId || !sessionData[sessionId]) {
        return res.status(400).json({ error: 'Invalid session ID' });
    }

    // add sessionid
    req.sessionId = sessionId;

    // call next middleware
    next();
}

// Middleware to clean expired session 
function cleanExpiredSessions() {
    const now = Date.now();
    for (const sessionId in sessionData) {
        if (sessionData[sessionId].expiry < now) {
            delete sessionData[sessionId];
            console.log("Session expired and data cleared -> " + sessionId);
        }
    }
}
// Clean expired session
setInterval(cleanExpiredSessions, 180000);//3 min

// Add images to a specific session ID
async function addImages(sessionId: string, files: Express.Multer.File[]): Promise<void> {
    if (!sessionData[sessionId]) {
        throw new Error('Invalid session ID');
    }

    const imageWithMetadataList: ImageWithMetadata[] = [];

    for (const file of files) {
        const imageId = uuidv4();
        try {
            // Extract metadata using the file's path
            const metadata = await extractMetadataFromImage(file.path);
            const imageWithMetadata: ImageWithMetadata = { id: imageId, file, metadata };
            imageWithMetadataList.push(imageWithMetadata);
            console.log("Image with metadata");
        } catch (error) {
            const imageWithMetadata: ImageWithMetadata = { id: imageId, file, metadata: null };
            imageWithMetadataList.push(imageWithMetadata);
            //console.log("Image without metadata");
        }
    }

    sessionData[sessionId].images.push(...imageWithMetadataList);
}

// Method for extracting JSON metadata from a file
async function extractMetadataFromImage(filePath: string): Promise<any> {
    return new Promise<any>(async (resolve, reject) => {
        try {
            // Read metadata from the file
            const tags = await exiftool.read(filePath);

            if (tags && tags.UserComment) {
                const userComment = tags.UserComment;
                
                try {
                    const shapes = JSON.parse(userComment);
                    resolve(shapes);
                } catch (error) {
                    reject('Error transforming UserComment to shapes.');
                }
            } else {
                reject('UserComment not found in the image metadata.');
            }
        } catch (error) {
            console.error('Error processing EXIF metadata:', error);
            reject('Error processing EXIF metadata.');
        }
    });
}

// Function to convert buffers to Multer files
function buffersToMulterFiles(sessionId: string, buffers: Buffer[], index: number): Express.Multer.File[] {
    return buffers.map((buffer, frameIndex) => {
        const tempPath = path.join(os.tmpdir(), `${sessionId}-${index}-frame-${frameIndex}.png`);
        fsPromises.writeFile(tempPath, buffer).catch(err => console.error(err)); // Use promises to handle file writing errors

        return {
            fieldname: 'images',
            originalname: `frame-${index}-${frameIndex}.png`,
            encoding: '7bit',
            mimetype: 'image/png',
            size: buffer.length,
            destination: os.tmpdir(),
            filename: `${sessionId}-${index}-frame-${frameIndex}.png`,
            path: tempPath,
            buffer: buffer,
            stream: Readable.from(buffer) // Create a readable stream from the buffer
        } as Express.Multer.File;
    });
}

// Function to get Max Frame Rate
async function getMaxFrameRate(videoPath: string): Promise<number> {
    return new Promise((resolve, reject) => {
        const ffprobeArgs = [
            '-v', 'error',
            '-select_streams', 'v:0',
            '-show_entries', 'stream=r_frame_rate',
            '-of', 'default=noprint_wrappers=1:nokey=1',
            videoPath
        ];

        const ffprobeProcess = spawn('ffprobe', ffprobeArgs);

        ffprobeProcess.stdout.on('data', (data) => {
            const fps = eval(data.toString().trim());
            resolve(fps);
        });

        ffprobeProcess.stderr.on('data', (data) => {
            console.error(`stderr: ${data}`);
            reject(data.toString());
        });

        ffprobeProcess.on('close', (code) => {
            if (code !== 0) {
                console.error(`ffprobe had error ${code}`);
                reject(`ffprobe had error ${code}`);
            }
        });

        ffprobeProcess.on('error', (err) => {
            console.error('Error with ffprobe:', err);
            reject(err);
        });
    });
}

// Function to process Video
async function processVideo(videoPath: string, requestedFrameRate: number, maxFrameRate: number, i: number): Promise<Buffer[]> {
    return new Promise((resolve, reject) => {
        const frameRate = Math.min(requestedFrameRate, maxFrameRate);
        console.log("Framerate usado-> " + frameRate);

        // Create a temporary directory for images
        const tempDir = tmp.dirSync({ unsafeCleanup: true });
        const outputDir = tempDir.name;

        // ffmpeg params
        const ffmpegArgs = [
            '-i', videoPath,
            '-vf', `fps=${frameRate}`,
            path.join(outputDir, `${i}-frame-%d.png`)
        ];

        // Start ffmpeg process
        const ffmpegProcess = spawn('ffmpeg', ffmpegArgs);

        ffmpegProcess.on('close', async (code) => {
            if (code === 0) {
                try {
                    // Read images from the temporary directory
                    let filenames = await fsPromises.readdir(outputDir);

                    // Sort filenames to ensure they are processed in the correct order
                    filenames = filenames.sort((a, b) => {
                        const aMatch = a.match(/(\d+)\.png$/);
                        const bMatch = b.match(/(\d+)\.png$/);
                        if (aMatch && bMatch) {
                            return parseInt(aMatch[1], 10) - parseInt(bMatch[1], 10);
                        }
                        return 0;
                    });

                    const imageBuffers = await Promise.all(filenames.map(async (filename) => {
                        const filePath = path.join(outputDir, filename);
                        return fsPromises.readFile(filePath);
                    }));

                    // Cleanup: delete files and directory
                    await Promise.all(filenames.map(async (filename) => {
                        const filePath = path.join(outputDir, filename);
                        await fsPromises.unlink(filePath);
                    }));

                    // Call removeCallback to clean up the temporary directory
                    tempDir.removeCallback();

                    resolve(imageBuffers);
                } catch (err) {
                    reject(err);
                }
            } else {
                reject(`Error with FFmpeg -> ${code}`);
            }
        });

        ffmpegProcess.on('error', (err) => {
            reject(err);
        });
    });
}

// Export image and metadata with Yolo forma on ZIP
async function exportAsYOLO(imageWithMetadata: ImageWithMetadata, res: Response): Promise<void> {
    const archive = archiver('zip', {
        zlib: { level: 9 }
    });

    // Check errors
    archive.on('error', (err) => {
        console.error('Error create Zip file:', err);
        res.status(500).send('Error create zip file');
    });

    archive.pipe(res);

    const image = imageWithMetadata.file;
    const annotations = metadataToYOLO(imageWithMetadata.metadata);
    const imageName = `image-${imageWithMetadata.id}.png`;
    const annotationFileName = imageName.replace(/\.[^/.]+$/, '.txt'); // Change extension .txt

    // Add image to file ZIP
    archive.file(image.path, { name: `${imageName}` });

    // Add annotation to file ZIP
    archive.append(annotations, { name: `${annotationFileName}` });

    // Finaliza el archivo ZIP
    await archive.finalize();
}

// Export all image and metadata with Yolo forma on ZIP
async function exportAllAsYOLO(imagesWithMetadata: ImageWithMetadata[], res: Response): Promise<void> {
    const archive = archiver('zip', {
        zlib: { level: 9 }
    });

    // Check errors
    archive.on('error', (err) => {
        console.error('Error create Zip file:', err);
        res.status(500).send('Error create zip file');
    });

    archive.pipe(res);

    for (const imageWithMetadata of imagesWithMetadata) {
    const image = imageWithMetadata.file;
    const annotations = metadataToYOLO(imageWithMetadata.metadata);
    const imageName = `image-${imageWithMetadata.id}.png`;
    const annotationFileName = imageName.replace(/\.[^/.]+$/, '.txt'); // Change extension .txt

    // Add image to file ZIP
    archive.file(image.path, { name: `images/${imageName}` });

    // Add annotation to file ZIP
    archive.append(annotations, { name: `labels/${annotationFileName}` });
    }

    // Finaliza el archivo ZIP
    await archive.finalize();
}

//use yolo format (darknet)
function metadataToYOLO(metadata: any[] | null): string {
    if (!metadata || metadata.length === 0) {
        return ''; // Return empty string if not exist metadata
    }

    return metadata.map(rect => {
        return `${rect.label} ${rect.x} ${rect.y} ${rect.width} ${rect.height}`;
    }).join('\n');
}

/*******************************SIGNALS***********************************/
// End exiftool
process.on('exit', async () => {
    await exiftool.end();
});

// Control SIGINT 
process.on('SIGINT', async () => {
    try {
        await exiftool.end();
        console.log('ExifTool finalizado correctamente.');
        process.exit();
    } catch (err) {
        console.error('Error al finalizar ExifTool:', err);
        process.exit(1);
    }
});


