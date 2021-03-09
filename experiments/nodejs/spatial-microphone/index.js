const { default: SignJWT } = require('jose/jwt/sign');
const crypto = require('crypto');
const auth = require('./auth.json');
const { Point3D, AudioAPIData, Communicator } = require("hifi-spatial-audio"); // Used to interface with the High Fidelity Spatial Audio API.
const { RTCAudioSink } = require('wrtc').nonstandard;
const Lame = require("node-lame").Lame;
const wav = require('wav');

// This is your "App ID" as obtained from the High Fidelity Audio API Developer Console. Do not share this string.
const APP_ID = auth.HIFI_APP_ID;
// This is the "App Secret" as obtained from the High Fidelity Audio API Developer Console. Do not share this string.
const APP_SECRET = auth.HIFI_APP_SECRET;
const SPACE_NAME = auth.HIFI_SPACE_NAME;
const SECRET_KEY_FOR_SIGNING = crypto.createSecretKey(Buffer.from(APP_SECRET, "utf8"));

const RECORDING_COLOR_HEX = "#FF0000";
const NOT_RECORDING_COLOR_HEX = "#525252";

async function generateHiFiJWT(userID, isAdmin) {
    let hiFiJWT;
    try {
        let jwtArgs = {
            "user_id": userID,
            "app_id": APP_ID
        };

        jwtArgs["space_name"] = SPACE_NAME;

        if (isAdmin) {
            jwtArgs["admin"] = true;
        }

        hiFiJWT = await new SignJWT(jwtArgs)
            .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
            .sign(SECRET_KEY_FOR_SIGNING);

        return hiFiJWT;
    } catch (error) {
        console.error(`Couldn't create JWT! Error:${error}`);
        return;
    }
}

class SpatialMicrophone {
    constructor({ spaceName, position } = {}) {
        this.spaceName = spaceName;
        // Define the initial HiFi Audio API Data used when connecting to the Spatial Audio API.
        this.audioAPIData = new AudioAPIData({
            position: new Point3D(position)
        });
        // Set up the HiFiCommunicator used to communicate with the Spatial Audio API.
        this.communicator = new Communicator({ initialHiFiAudioAPIData: this.audioAPIData });
        this.stereoSamples = new Int16Array();
        this.startRecordTime = undefined;
        this.initialized = false;
        this.wantedToImmediatelyStartRecording = false;
        this.isRecording = false;
    }

    async init() {
        // Generate the JWT used to connect to our High Fidelity Space.
        let hiFiJWT = await generateHiFiJWT("spatial-microphone", this.spaceName);
        if (!hiFiJWT) {
            console.error(`Couldn't get HiFi JWT! Spatial microphone will not function.`)
            return;
        }

        // Connect to our High Fidelity Space.
        try {
            let connectResponse = await this.communicator.connectToHiFiAudioAPIServer(hiFiJWT);
            this.visitIDHash = connectResponse.audionetInitResponse.visit_id_hash;
        } catch (e) {
            console.error(`Call to \`connectToHiFiAudioAPIServer()\` failed! Error:\n${JSON.stringify(e)}`);
            return;
        }
        console.log(`Spatial microphone is connected to Space named \`${this.spaceName}\` at ${JSON.stringify(this.audioAPIData.position)}!`);
        this.outputAudioMediaStreamTrack = this.communicator.getOutputAudioMediaStream().getTracks()[0];
        this.initialized = true;
        
        spatialSpeakerSpaceSocket.emit("addParticipant", { visitIDHash: this.visitIDHash, displayName: "🎤 Mic", participantType: "spatialMicrophone", spaceName: this.spaceName, isRecording: this.isRecording, colorHex: this.isRecording ? RECORDING_COLOR_HEX : NOT_RECORDING_COLOR_HEX });

        if (this.wantedToImmediatelyStartRecording) {
            this.startRecording();
            this.wantedToImmediatelyStartRecording = false;
        }
    }

    deinit() {
        console.log("De-initializing Spatial Microphone...");
        this.finishRecording(this.spaceName);
        spatialSpeakerSpaceSocket.emit("removeParticipant", { visitIDHash: this.visitIDHash, spaceName: this.spaceName });
        this.outputAudioMediaStreamTrack = null;
    }

    disconnect() {
        console.log("Disconnecting Spatial Microphone...");
        this.deinit();
        if (this.communicator) {
            this.communicator.disconnectFromHiFiAudioAPIServer();
        }
        this.communicator = null;
    }

    startRecording() {
        console.log(`Starting to record from spatial microphone in \`${this.spaceName}\`...`);

        this.isRecording = true;
        spatialSpeakerSpaceSocket.emit("editParticipant", { visitIDHash: this.visitIDHash, spaceName: this.spaceName, isRecording: this.isRecording, colorHex: RECORDING_COLOR_HEX });
        this.startRecordTime = Date.now();

        this.stereoSamples = new Int16Array();

        this.rtcAudioSink = new RTCAudioSink(this.outputAudioMediaStreamTrack);
        this.rtcAudioSink.ondata = (data) => {
            if (this.stereoSamples.length === 0) {
                console.log(`\`rtcAudioSink\` received initial audio data!`);
            }

            let newStereoSamples = data.samples;
            let temp = new Int16Array(this.stereoSamples.length + newStereoSamples.length);
            temp.set(this.stereoSamples, 0);
            temp.set(newStereoSamples, this.stereoSamples.length);
            this.stereoSamples = temp;
        };
    }

    async finishRecording(filetype) {
        if (!this.isRecording) {
            return;
        }
        
        console.log(`Stopping the recording from spatial microphone in \`${this.spaceName}\`...`);
        console.log(`Recording length: ${(Date.now() - this.startRecordTime) / 1000}s`);

        this.isRecording = false;
        spatialSpeakerSpaceSocket.emit("editParticipant", { visitIDHash: this.visitIDHash, spaceName: this.spaceName, isRecording: this.isRecording, colorHex: NOT_RECORDING_COLOR_HEX });

        if (this.rtcAudioSink) {
            this.rtcAudioSink.stop();
            this.rtcAudioSink.ondata = null;
        }
        this.rtcAudioSink = null;

        const finalBuffer = Buffer.from(this.stereoSamples.buffer);

        if (!filetype || filetype === "wav") {
            const filename = `./output/${Date.now()}.wav`;
            const writer = new wav.FileWriter(filename, {
                sampleRate: 48000,
                channels: 2,
                bitDepth: 16,
            });
            writer.write(finalBuffer);
            writer.end();
            this.stereoSamples = new Int16Array();
            console.log(`Successfully wrote recording to \`${filename}\`!`);
            return filename;
        } else if (filetype === "mp3") {
            const filename = `./output/${Date.now()}.mp3`;
            this.encoder = new Lame({
                "output": filename,
                "raw": true,
                "bitwidth": 16,
                "sfreq": 48,
                "mode": "s",
                "signed": true,
                "unsigned": false,
                "little-endian": true,
                "big-endian": false,
                "no-replaygain": true,
                "bitrate": 128, // Output bitrate
            }).setBuffer(finalBuffer);

            this.encoder.encode()
                .then(() => {
                    console.log(`Successfully wrote recording to \`${filename}\`!`);
                    this.stereoSamples = new Int16Array();
                    return filename;
                })
                .catch((error) => {
                    console.error(`Couldn't encode samples from Spatial Microphone! Error:\n${error}`);
                    this.stereoSamples = new Int16Array();
                    return null;
                });
        }
    }
}

console.log(`In \`${SPACE_NAME}\`, creating a new Spatial Microphone...`);
let spatialMicrophone = new SpatialMicrophone({ spaceName: SPACE_NAME, position: new Point3D({ x: 0, y: 0, z: 0 }) });
spatialMicrophone.init();

const httpServer = require("http").createServer();

const io = require("socket.io")(httpServer, {
    path: '/spatial-microphone/socket.io',
    cors: {
        origin: `*`,
        methods: ["GET", "POST"]
    }
});

io.on("error", (e) => {
    console.error(e);
});

function startRecording(socket) {
    if (!spatialMicrophone) {
        return;
    }

    if (spatialMicrophone.initialized) {
        spatialMicrophone.startRecording();
        socket.emit("recordingStarted");
    } else {
        spatialMicrophone.wantedToImmediatelyStartRecording = true;
    }
}

async function finishRecording(socket) {
    if (!spatialMicrophone) {
        return;
    }
    
    const recordingFilename = await spatialMicrophone.finishRecording("wav");
    socket.emit("recordingFinished", { recordingFilename });
}

async function toggleRecording(socket) {
    if (!spatialMicrophone) {
        return;
    }

    if (spatialMicrophone.isRecording) {
        await finishRecording(socket);
    } else {
        startRecording(socket);
    }
}
io.on("connection", (socket) => {
    socket.on("startRecording", () => {
        startRecording(socket);
    });

    socket.on("finishRecording", async () => {
        await finishRecording(socket);
    });

    socket.on("toggleRecording", async () => {
        await toggleRecording(socket);
    });
});

const PORT = 8124;
httpServer.listen(PORT, async () => {
    console.log(`Spatial Microphone is ready and listening at http://localhost:${PORT}`)
});

const spatialSpeakerSpaceSocket = require("socket.io-client").connect('http://localhost:8123', { path: '/spatial-speaker-space/socket.io' });
spatialSpeakerSpaceSocket.on('connect', (socket) => {
    console.log('Connected to Spatial Speaker Space!');
});

process.on('SIGINT', () => {    
    if (spatialMicrophone) {
        spatialMicrophone.disconnect();
    }

    process.exit();
});