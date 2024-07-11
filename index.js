const express = require('express');
const { ExifTool } = require('exiftool-vendored');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const cors = require('cors'); // Importar cors
const { spawn } = require('child_process'); // Importar spawn correctamente
const os = require('os');
const archiver = require('archiver');
const { v4: uuidv4 } = require('uuid'); // Asegúrate de instalar 'uuid'

const corsOptions = {
    origin: 'http://localhost:4200', // URL del frontend Angular
    optionsSuccessStatus: 200, // Algunos navegadores antiguos (IE11, varios SmartTVs) interpretan erroneamente los codigos 204 como fallos
};

const app = express();
const PORT = process.env.PORT || 3000;
const exiftool = new ExifTool();

// Configuración de multer para gestionar la carga de archivos
const upload = multer({ dest: os.tmpdir() });

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors(corsOptions));


// Ruta para procesar videos y devolver archivos modificados
app.post('/api/procesar-video', upload.array('files'), async (req, res) => {
    const frameRates = JSON.parse(req.body.frameRates);
    console.log(frameRates);
    const files = req.files;
    const processedFiles = [];

    // Generar un UUID para esta solicitud
    const requestId = uuidv4();
    const outputDir = path.join(os.tmpdir(), 'processed_images_${requestId}');
    // Borrar el directorio outputDir si existe previamente
    if (fs.existsSync(outputDir)) {
        fs.rmSync(outputDir, { recursive: true });
    }

    // Crear el directorio outputDir nuevamente
    fs.mkdirSync(outputDir);

    try {
        for (let i = 0; i < files.length; i++) {
            console.log("Processing file " + i);
            const videoPath = files[i].path;
            const frameRate = frameRates[i];
            console.log("Take max FPS -> ");
            const maxFrameRate = await getMaxFrameRate(videoPath);
            console.log(maxFrameRate);
            console.log("Processing Video to Images");
            const outputImages = await processVideo(videoPath, frameRate, maxFrameRate, outputDir, i);
            console.log("Ending Video to Images");
            processedFiles.push(...outputImages);
        }

        console.log("Creando el zip");
        // Nombre del archivo ZIP que se enviará
        const zipFileName = 'processed_files.zip';

        // Configurar Archiver para comprimir los archivos en un ZIP
        const archive = archiver('zip', {
            zlib: { level: 9 } // Nivel de compresión máximo
        });

        // Configurar salida hacia el cliente
        res.attachment(zipFileName); // Establecer el nombre del archivo para la descarga
        archive.pipe(res); // Canalizar la salida hacia la respuesta HTTP

         // Agregar archivos al ZIP desde processedFiles
         processedFiles.forEach(filePath => {
            const fileName = path.basename(filePath); // Obtener el nombre del archivo seguro
            console.log("Agregando la imagen-> " + fileName);
            // Agregar cada archivo al ZIP usando su ruta y nombre
            archive.append(fs.createReadStream(filePath), { name: fileName });
        });

        // Finalizar el ZIP y enviarlo
        archive.finalize();

        // Eventos para asegurarse de que el zip se ha enviado correctamente
        archive.on('end', () => {
            console.log('Enviado el zip');
        });

        archive.on('error', (err) => {
            console.error('Error al crear el zip:', err);
            res.status(500).send({ error: 'Error al crear el zip.' });
        });
        
    } catch (error) {
        console.error('Error al procesar los videos:', error);
        res.status(500).json({ error: 'Error al procesar los videos.' });
    }
});

// Ruta para manejar la carga de imagen con metadatos
app.post('/api/agregar-metadatos', upload.single('imagen'), async (req, res) => {
    const jsonMetadata = req.body.jsonMetadata;
    const { path: imagePath } = req.file;
    console.log(jsonMetadata);

    try {
        if (fs.existsSync(imagePath)) {
            // Escribir en el campo UserComment
            await exiftool.write(imagePath, { UserComment: jsonMetadata });
            console.log('UserComment written successfully');

            const modifiedImagePath = path.isAbsolute(imagePath) ? imagePath : path.join(__dirname, imagePath);

            // Leer todos los tags disponibles
            const tags = await exiftool.read(modifiedImagePath);
            console.log(`Tags: ${JSON.stringify(tags, null, 2)}`);

            // Verificar si UserComment está presente en los tags
            if (tags.UserComment) {
                console.log(`UserComment: ${tags.UserComment}`);
            } else {
                console.error('UserComment not found in tags');
            }

            res.sendFile(modifiedImagePath)
        } else {
            console.error("The specified image path does not exist.");
            res.status(400).json({ error: 'The specified image path does not exist.' });
        }
    } catch (error) {
        console.error('Error al embeber metadatos en la imagen:', error);
        res.status(500).json({ error: 'Error al embeber metadatos en la imagen.' });
    }
});


app.listen(PORT, () => {
    console.log(`Servidor backend iniciado en puerto ${PORT}`);
});

// Finalizar el proceso de exiftool al cerrar la aplicación
process.on('exit', async () => {
    await exiftool.end();
});

// Manejar la señal SIGINT para una terminación limpia
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

/*
// Función para limpiar un directorio específico
function cleanupDirectory(directory) {
    fs.readdir(directory, (err, files) => {
        if (err) throw err;

        for (const file of files) {
            const filePath = path.join(directory, file);
            fs.unlink(filePath, err => {
                if (err) throw err;
                console.log(`Archivo ${filePath} eliminado correctamente.`);
            });
        }
    });
}*/

// Función para obtener el framerate máximo del video
async function getMaxFrameRate(videoPath) {
    return new Promise((resolve, reject) => {
        // Argumentos para ffprobe para obtener el framerate máximo del video
        const ffprobeArgs = [
            '-v', 'error',
            '-select_streams', 'v:0',
            '-show_entries', 'stream=r_frame_rate',
            '-of', 'default=noprint_wrappers=1:nokey=1',
            videoPath
        ];

        const ffprobeProcess = spawn('ffprobe', ffprobeArgs);

        ffprobeProcess.stdout.on('data', (data) => {
            const fps = parseFloat(data.toString().trim());
            resolve(fps);
        });

        ffprobeProcess.stderr.on('data', (data) => {
            console.error(`stderr: ${data}`);
            reject(data.toString());
        });

        ffprobeProcess.on('close', (code) => {
            if (code !== 0) {
                console.error(`ffprobe finalizó con código de error ${code}`);
                reject(`ffprobe finalizó con código de error ${code}`);
            }
        });

        ffprobeProcess.on('error', (err) => {
            console.error('Error al ejecutar ffprobe:', err);
            reject(err);
        });
    });
}

function getFilesInDirectory(directory) {
    const files = fs.readdirSync(directory);
    return files.map(file => {
        const filePath = path.join(directory, file);
        const fileStats = fs.statSync(filePath);
        const fileData = fs.readFileSync(filePath);
        // Aquí aseguramos que el nombre del archivo no esté vacío
        const fileName = file || 'unknown.png'; // En caso de que el nombre sea vacío, asignamos uno por defecto

        return new File([fileData], fileName, { type: 'image/png', lastModified: fileStats.mtime });
    });
}

// Función para obtener los paths de los archivos en un directorio
function getFilePathsInDirectory(directory) {
    const files = fs.readdirSync(directory);
    return files.map(file => path.join(directory, file));
}

async function processVideo(videoPath, requestedFrameRate, maxFrameRate, outputDir, i) {
    return new Promise((resolve, reject) => {
        let outputImages = [];

        const frameRate = Math.min(requestedFrameRate, maxFrameRate);

        const ffmpegArgs = [
            '-i', videoPath,
            '-vf', `fps=${frameRate}`,
            path.join(outputDir, `${i}-frame-%d.png`)
        ];

        const ffmpegProcess = spawn('ffmpeg', ffmpegArgs);

        ffmpegProcess.on('close', (code) => {
            if (code === 0) {
                // Obtener los paths de las imágenes procesadas
                const imagePaths = getFilePathsInDirectory(outputDir);

                // Resolver la promesa con los paths y los datos de las imágenes si es necesario
                resolve(imagePaths);
            } else {
                reject(`FFmpeg finalizó con código de error ${code}`);
            }
        });

        ffmpegProcess.on('error', (err) => {
            reject(err);
        });
    });
}
