const express = require("express")
const multer = require("multer")
const axios = require("axios")
const cors = require("cors")
const fs = require("fs")
const path = require("path")
const cookieParser = require("cookie-parser")
const rateLimit = require("express-rate-limit")
const helmet = require("helmet")
const compression = require("compression")

const app = express()
const PORT = process.env.PORT || 3000

// Store counters with file persistence
const COUNTERS_FILE = path.join(__dirname, 'counters.json')

// Initialize counters
let counters = {
  successful: 0,
  failed: 0,
  total: 0,
  lastReset: new Date().toISOString()
}

// Load counters from file if exists
if (fs.existsSync(COUNTERS_FILE)) {
  try {
    const data = fs.readFileSync(COUNTERS_FILE, 'utf8')
    const savedCounters = JSON.parse(data)
    counters = savedCounters
    console.log('📊 Counters loaded:', counters)
  } catch (error) {
    console.error('Error loading counters:', error)
  }
}

// Save counters to file
function saveCounters() {
  try {
    fs.writeFileSync(COUNTERS_FILE, JSON.stringify(counters, null, 2))
    console.log('📊 Counters saved:', counters)
  } catch (error) {
    console.error('Error saving counters:', error)
  }
}

// Security middleware
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false
}))

app.use(compression())
app.use(cors({
  origin: process.env.NODE_ENV === 'production' ? 'your-domain.com' : '*',
  credentials: true
}))

app.use(cookieParser())
app.set("trust proxy", true)
app.use(express.json({ limit: '10mb' }))
app.use(express.urlencoded({ extended: true, limit: '10mb' }))
app.use(express.static("public"))
app.use("/uploads", express.static("uploads"))

// Rate limiting
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { error: "Too many requests, please try again later." }
})

app.use("/api/", apiLimiter)

// Ensure uploads directory exists
const uploadsDir = "uploads"
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true })
}

// Multer configuration
const storage = multer.diskStorage({
  destination: uploadsDir,
  filename: (_, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9)
    cb(null, uniqueSuffix + path.extname(file.originalname).toLowerCase())
  }
})

const fileFilter = (req, file, cb) => {
  const allowedTypes = /jpeg|jpg|png|webp|bmp/
  const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase())
  const mimetype = allowedTypes.test(file.mimetype)

  if (mimetype && extname) {
    cb(null, true)
  } else {
    cb(new Error('Only image files are allowed!'), false)
  }
}

const upload = multer({
  storage,
  fileFilter,
  limits: { 
    fileSize: 20 * 1024 * 1024,
    files: 1
  }
})

// Utility functions
const fileURL = (req, file) => {
  const protocol = req.headers['x-forwarded-proto'] || req.protocol
  return `${protocol}://${req.get("host")}/uploads/${file.filename}`
}

const cleanupOldFiles = () => {
  fs.readdir(uploadsDir, (err, files) => {
    if (err) return

    const now = Date.now()
    files.forEach(file => {
      const filePath = path.join(uploadsDir, file)
      fs.stat(filePath, (err, stat) => {
        if (err) return

        if (now - stat.mtimeMs > 3600000) {
          fs.unlink(filePath, () => {
            console.log(`Cleaned up old file: ${file}`)
          })
        }
      })
    })
  })
}

// API Routes
app.post("/api/removebg", upload.single("image"), async (req, res) => {
  try {
    if (!req.file) {
      counters.failed++
      counters.total++
      saveCounters()
      return res.status(400).json({ 
        success: false, 
        error: "No image file provided" 
      })
    }

    const imgUrl = fileURL(req, req.file)
    const apiUrl = `https://api-library-kohi.onrender.com/api/removebg?url=${encodeURIComponent(imgUrl)}`

    const response = await axios.get(apiUrl, { timeout: 30000 })

    if (response.data?.data?.url) {
      // Successful processing
      counters.successful++
      counters.total++
      saveCounters()
      
      res.json({ 
        success: true, 
        url: response.data.data.url,
        message: "Background removed successfully!",
        stats: {
          successful: counters.successful,
          failed: counters.failed,
          total: counters.total
        }
      })
    } else {
      throw new Error("Invalid response from background removal service")
    }
  } catch (error) {
    console.error("Remove BG error:", error.message)
    counters.failed++
    counters.total++
    saveCounters()
    
    res.status(500).json({ 
      success: false, 
      error: "Failed to remove background. Please try again.",
      stats: {
        successful: counters.successful,
        failed: counters.failed,
        total: counters.total
      }
    })
  }
})

// Get counters endpoint
app.get("/api/counters", (req, res) => {
  res.json({
    success: true,
    stats: {
      successful: counters.successful,
      failed: counters.failed,
      total: counters.total,
      successRate: counters.total > 0 ? ((counters.successful / counters.total) * 100).toFixed(1) : 0
    },
    lastReset: counters.lastReset
  })
})

// Reset counters (admin only - add your own auth)
app.post("/api/reset-counters", (req, res) => {
  const adminKey = req.headers['x-admin-key']
  
  // Simple admin key check - change this to your own secret
  if (adminKey !== 'your-secret-admin-key-123') {
    return res.status(403).json({ success: false, error: "Unauthorized" })
  }
  
  counters = {
    successful: 0,
    failed: 0,
    total: 0,
    lastReset: new Date().toISOString()
  }
  saveCounters()
  
  res.json({ 
    success: true, 
    message: "Counters reset successfully",
    stats: counters
  })
})

app.get("/api/info", (req, res) => {
  res.json({
    success: true,
    ip: req.headers["x-forwarded-for"]?.split(",")[0] || req.socket.remoteAddress || "Unknown",
    time: new Date().toISOString(),
    serverTime: new Date().toLocaleString()
  })
})

app.post("/api/accept-terms", (req, res) => {
  const oneYear = 365 * 24 * 60 * 60 * 1000
  res.cookie("termsAccepted", "true", {
    maxAge: oneYear,
    sameSite: "lax",
    secure: process.env.NODE_ENV === 'production',
    httpOnly: false
  })
  res.json({ success: true, message: "Terms accepted successfully" })
})

app.get("/api/download", async (req, res) => {
  try {
    const url = req.query.url

    if (!url || !url.startsWith('http')) {
      return res.status(400).json({ 
        success: false, 
        error: "Valid URL is required" 
      })
    }

    const response = await axios({
      method: 'get',
      url: url,
      responseType: 'stream',
      timeout: 30000
    })

    const contentType = response.headers['content-type'] || 'application/octet-stream'
    const filename = `processed_image_${Date.now()}${path.extname(url.split('?')[0]) || '.png'}`

    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`)
    res.setHeader("Content-Type", contentType)
    res.setHeader("Cache-Control", "no-store")

    response.data.pipe(res)
  } catch (error) {
    console.error("Download error:", error.message)
    res.status(500).json({ 
      success: false, 
      error: "Failed to download image" 
    })
  }
})

app.get("/health", (req, res) => {
  res.json({ 
    status: "healthy", 
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    stats: {
      successful: counters.successful,
      failed: counters.failed,
      total: counters.total
    }
  })
})

// Redirect root to portal
app.get("/", (req, res) => {
  if (req.cookies.termsAccepted === "true") {
    res.sendFile(path.join(__dirname, "public", "index.html"))
  } else {
    res.sendFile(path.join(__dirname, "portal.html"))
  }
})

// Cleanup old files every 30 minutes
setInterval(cleanupOldFiles, 30 * 60 * 1000)
cleanupOldFiles()

// Save counters on process exit
process.on('SIGINT', () => {
  saveCounters()
  process.exit()
})

process.on('SIGTERM', () => {
  saveCounters()
  process.exit()
})

// Error handling middleware
app.use((req, res) => {
  res.status(404).sendFile(path.join(__dirname, "public", "404.html"))
})

app.use((err, req, res, next) => {
  console.error(err.stack)
  res.status(500).sendFile(path.join(__dirname, "public", "500.html"))
})

app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`)
  console.log(`📁 Upload directory: ${path.join(__dirname, uploadsDir)}`)
  console.log(`📊 Current stats: ${counters.successful} successful, ${counters.failed} failed`)
  console.log(`🌐 Environment: ${process.env.NODE_ENV || 'development'}`)
})

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason)
})

process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error)
  saveCounters()
  process.exit(1)
})
