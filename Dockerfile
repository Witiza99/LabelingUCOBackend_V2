# Utilizar una imagen base de Node.js basada en Debian
FROM node:20.11.1

# Instalar FFmpeg
RUN apt-get update && apt-get install -y ffmpeg

# Crear y establecer el directorio de trabajo
WORKDIR /app

# Copiar los archivos de configuración y de dependencias
COPY package*.json ./

# Instalar las dependencias del proyecto
RUN npm install

# Copiar el resto de los archivos de la aplicación
COPY . .

# Exponer el puerto en el que la aplicación se ejecutará
EXPOSE 3000

# Comando para ejecutar la aplicación
CMD ["npm", "start"]

