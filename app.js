const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const { Readable } = require('stream'); // 추가된 stream 모듈
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());  // CORS 설정 추가

const mongoUrl = "mongodb+srv://ckdgml1302:admin@cluster0.cw4wxud.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0";

mongoose.connect(mongoUrl)
  .then(() => console.log("Database connected"))
  .catch(err => console.log(err));

const conn = mongoose.connection;
let gfs;
conn.once('open', () => {
  gfs = new mongoose.mongo.GridFSBucket(conn.db, { bucketName: 'recordings' });
});

const storage = multer.memoryStorage();
const upload = multer({ storage });

require('./UserDetails');
require('./recordingModel');

const User = mongoose.model("UserInfo");
const Recording = mongoose.model("Recording");

app.get("/", (req, res) => {
  res.send({ status: "서버가 시작되었습니다." });
});

app.post("/register", async (req, res) => {
  const { name, email, mobile, password } = req.body;
  const oldUser = await User.findOne({ email });

  if (oldUser) {
    return res.send({ status: "error", message: "이미 존재하는 사용자입니다!" });
  }

  const encryptedPassword = await bcrypt.hash(password, 10);

  try {
    await User.create({
      name,
      email,
      mobile,
      password: encryptedPassword,
    });
    res.send({ status: "ok", message: "사용자가 생성되었습니다." });
  } catch (error) {
    console.error('Error during user registration:', error);
    res.status(500).send({ status: "error", message: error.message });
  }
});

app.post("/login", async (req, res) => {
  const { name, password } = req.body;

  try {
    const user = await User.findOne({ name });

    if (!user) {
      return res.status(404).send({ status: "error", message: "사용자를 찾을 수 없습니다." });
    }

    const isPasswordMatch = await bcrypt.compare(password, user.password);

    if (!isPasswordMatch) {
      return res.status(401).send({ status: "error", message: "비밀번호가 올바르지 않습니다." });
    }

    const token = jwt.sign({ userId: user._id }, 'your_secret_key', { expiresIn: '24h' });
    res.send({ status: "ok", token: token });
  } catch (error) {
    console.error('Error during user login:', error);
    res.status(500).send({ status: "error", message: error.message });
  }
});

// 인증 토큰 확인 미들웨어
const verifyToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  if (!authHeader) return res.status(403).send('토큰이 필요합니다.');

  const token = authHeader.split(' ')[1];
  if (!token) return res.status(403).send('토큰이 필요합니다.');

  jwt.verify(token, 'your_secret_key', (err, decoded) => {
    if (err) return res.status(401).send('유효하지 않은 토큰입니다.');
    req.userId = decoded.userId;
    next();
  });
};

// 녹음 파일 업로드 엔드포인트
app.post('/recordings', verifyToken, upload.single('file'), async (req, res) => {
  console.log('File upload request received');
  const { fileName } = req.body;
  console.log('Request body:', req.body);

  if (!req.file) {
    console.error('No file received');
    return res.status(400).send({ status: 'error', message: 'No file received' });
  }

  console.log('Uploaded file details:', req.file);

  const readableStream = new Readable();
  readableStream._read = () => {};
  readableStream.push(req.file.buffer);
  readableStream.push(null);

  const uploadStream = gfs.openUploadStream(fileName, {
    contentType: req.file.mimetype,
  });

  readableStream.pipe(uploadStream);

  uploadStream.on('finish', async () => {
    const newRecording = new Recording({
      userId: req.userId,
      fileName,
      fileId: uploadStream.id
    });

    try {
      await newRecording.save();
      console.log('Recording saved to database:', newRecording);
      res.send({ status: 'ok', recording: newRecording });
    } catch (error) {
      console.error('Error saving recording to database:', error);
      res.status(500).send({ status: 'error', message: 'Failed to save recording' });
    }
  });

  uploadStream.on('error', (error) => {
    console.error('Error uploading file to GridFS:', error);
    res.status(500).send({ status: 'error', message: 'Failed to upload file' });
  });
});

// 사용자 녹음 파일 가져오기 엔드포인트
app.get('/recordings', verifyToken, async (req, res) => {
  try {
    const recordings = await Recording.find({ userId: req.userId });
    console.log('Recordings retrieved:', recordings);
    res.send({ status: 'ok', recordings });
  } catch (error) {
    console.error('Error retrieving recordings:', error);
    res.status(500).send({ status: 'error', message: 'Failed to retrieve recordings' });
  }
});

// 녹음 파일 삭제 엔드포인트
app.delete('/recordings/:id', verifyToken, async (req, res) => {
  try {
    const recording = await Recording.findById(req.params.id);
    if (!recording) {
      console.error('Recording not found:', req.params.id);
      return res.status(404).send({ status: 'error', message: 'Recording not found' });
    }

    // GridFS 파일 삭제
    try {
      const fileId = new mongoose.Types.ObjectId(recording.fileId);
      await gfs.delete(fileId);
      console.log('File deleted from GridFS:', fileId);
    } catch (gridFsError) {
      if (gridFsError.message.includes('File not found')) {
        console.warn('File not found in GridFS, skipping deletion:', recording.fileId);
      } else {
        console.error('Error deleting file from GridFS:', gridFsError);
        return res.status(500).send({ status: 'error', message: 'Failed to delete recording file' });
      }
    }

    // 데이터베이스에서 녹음 삭제
    try {
      await Recording.deleteOne({ _id: req.params.id });
      console.log('Recording deleted from database:', recording);
      return res.send({ status: 'ok' });
    } catch (dbError) {
      console.error('Error deleting recording from database:', dbError);
      return res.status(500).send({ status: 'error', message: 'Failed to delete recording' });
    }
  } catch (error) {
    console.error('Error deleting recording:', error);
    res.status(500).send({ status: 'error', message: 'Failed to delete recording' });
  }
});



app.listen(5001, () => {
  console.log("Node.js 서버가 시작되었습니다.");
});
