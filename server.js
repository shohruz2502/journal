// Электронный журнал — Express + SQLite3 + Socket.IO
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const http = require('http');

const app = express();
const server = http.createServer(app);
const io = require('socket.io')(server);

const DB_FILE = path.join(__dirname, 'database.db');

app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

// Open DB
const db = new sqlite3.Database(DB_FILE, (err) => {
  if (err) {
    console.error('Cannot open database', err);
    process.exit(1);
  }
  console.log('Connected to SQLite database');
});

// Initialize tables
db.serialize(() => {
  // Таблица для общих записей (оставлена для обратной совместимости)
  db.run(`CREATE TABLE IF NOT EXISTS entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    date TEXT,
    note TEXT,
    updatedAt TEXT
  )`);

  // Таблица студентов
  db.run(`CREATE TABLE IF NOT EXISTS students (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    group_name TEXT NOT NULL,
    course INTEGER NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`);

  // Таблица посещаемости (обновлена для почасового учета)
  db.run(`CREATE TABLE IF NOT EXISTS attendance (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id INTEGER NOT NULL,
    date TEXT NOT NULL,
    hour INTEGER NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(student_id, date, hour),
    FOREIGN KEY(student_id) REFERENCES students(id) ON DELETE CASCADE
  )`);

  // Создаем индексы для улучшения производительности
  db.run(`CREATE INDEX IF NOT EXISTS idx_attendance_date ON attendance(date)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_attendance_student_date ON attendance(student_id, date)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_attendance_student_date_hour ON attendance(student_id, date, hour)`);
});

function runAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function(err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}

function allAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

function getAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

// API для студентов
app.get('/api/students', async (req, res) => {
  try {
    const rows = await allAsync('SELECT * FROM students ORDER BY name ASC');
    // Преобразуем group_name в group для совместимости с клиентом
    const students = rows.map(row => ({
      id: row.id,
      name: row.name,
      group: row.group_name,
      course: row.course,
      created_at: row.created_at
    }));
    res.json(students);
  } catch (e) {
    console.error('Error getting students:', e);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/students', async (req, res) => {
  try {
    const { name, group, course } = req.body;
    console.log('Adding student:', { name, group, course });
    
    if (!name || !group || course === undefined) {
      return res.status(400).json({ error: 'Missing required fields: name, group, course' });
    }

    const result = await runAsync(
      'INSERT INTO students (name, group_name, course) VALUES (?, ?, ?)',
      [name, group, course]
    );
    
    const inserted = await getAsync('SELECT * FROM students WHERE id = ?', [result.lastID]);
    
    const studentForClient = {
      id: inserted.id,
      name: inserted.name,
      group: inserted.group_name,
      course: inserted.course
    };
    
    io.emit('student_added', studentForClient);
    res.json(studentForClient);
  } catch (e) {
    console.error('Error adding student:', e);
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/students/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    console.log('Deleting student:', id);
    
    const row = await getAsync('SELECT * FROM students WHERE id = ?', [id]);
    if (!row) return res.status(404).json({ error: 'Student not found' });
    
    await runAsync('DELETE FROM attendance WHERE student_id = ?', [id]);
    await runAsync('DELETE FROM students WHERE id = ?', [id]);
    
    io.emit('student_deleted', id);
    res.json({ deletedId: id, message: 'Student deleted successfully' });
  } catch (e) {
    console.error('Error deleting student:', e);
    res.status(500).json({ error: e.message });
  }
});

// API для посещаемости (обновлено для почасового учета)
app.get('/api/attendance', async (req, res) => {
  try {
    const rows = await allAsync(`
      SELECT student_id, date, hour, status 
      FROM attendance 
      ORDER BY date DESC, student_id, hour
    `);
    
    // Преобразуем в формат для фронтенда
    const attendanceData = {
      daily: {},
      hourly: {}
    };
    
    rows.forEach(row => {
      // Для обратной совместимости - daily данные
      if (!attendanceData.daily[row.date]) {
        attendanceData.daily[row.date] = {};
      }
      
      // Для почасового учета
      if (!attendanceData.hourly[row.date]) {
        attendanceData.hourly[row.date] = {};
      }
      if (!attendanceData.hourly[row.date][row.student_id]) {
        attendanceData.hourly[row.date][row.student_id] = {};
      }
      
      attendanceData.hourly[row.date][row.student_id][row.hour] = row.status;
      
      // Для daily определяем статус по большинству часов
      const hours = Object.values(attendanceData.hourly[row.date][row.student_id]);
      const presentCount = hours.filter(s => s === 'present').length;
      const absentCount = hours.filter(s => s === 'absent').length;
      
      if (presentCount > absentCount) {
        attendanceData.daily[row.date][row.student_id] = 'present';
      } else if (absentCount > presentCount) {
        attendanceData.daily[row.date][row.student_id] = 'absent';
      } else if (presentCount > 0 || absentCount > 0) {
        attendanceData.daily[row.date][row.student_id] = 'mixed';
      }
    });
    
    res.json(attendanceData);
  } catch (e) {
    console.error('Error getting attendance:', e);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/attendance', async (req, res) => {
  try {
    const { studentId, date, status, hour = null } = req.body;
    console.log('Saving attendance:', { studentId, date, status, hour });
    
    if (!studentId || !date || !status) {
      return res.status(400).json({ error: 'Missing required fields: studentId, date, status' });
    }
    
    const student = await getAsync('SELECT * FROM students WHERE id = ?', [studentId]);
    if (!student) {
      return res.status(404).json({ error: 'Student not found' });
    }
    
    if (hour !== null && hour !== undefined) {
      // Почасовой учет
      if (status === 'unknown') {
        // Удаляем запись если статус unknown
        await runAsync(
          'DELETE FROM attendance WHERE student_id = ? AND date = ? AND hour = ?',
          [studentId, date, hour]
        );
      } else {
        // Вставляем или обновляем запись
        await runAsync(
          `INSERT OR REPLACE INTO attendance (student_id, date, hour, status) 
           VALUES (?, ?, ?, ?)`,
          [studentId, date, hour, status]
        );
      }
    } else {
      // Ежедневный учет (для обратной совместимости)
      // Удаляем все часовые записи за этот день
      await runAsync(
        'DELETE FROM attendance WHERE student_id = ? AND date = ?',
        [studentId, date]
      );
      
      if (status !== 'unknown') {
        // Создаем записи для всех часов
        for (let h = 1; h <= 5; h++) {
          await runAsync(
            'INSERT INTO attendance (student_id, date, hour, status) VALUES (?, ?, ?, ?)',
            [studentId, date, h, status]
          );
        }
      }
    }
    
    const attendanceData = {
      studentId: parseInt(studentId),
      date: date,
      status: status,
      hour: hour
    };
    
    io.emit('attendance_updated', attendanceData);
    res.json({ success: true, ...attendanceData });
    
  } catch (e) {
    console.error('Error saving attendance:', e);
    res.status(500).json({ error: e.message });
  }
});

// Получение посещаемости за период
app.get('/api/attendance/period', async (req, res) => {
  try {
    const { startDate, endDate, group } = req.query;
    
    let query = `
      SELECT s.id as student_id, s.name, s.group_name, a.date, a.hour, a.status
      FROM students s
      LEFT JOIN attendance a ON s.id = a.student_id 
        AND a.date BETWEEN ? AND ?
    `;
    
    const params = [startDate, endDate];
    
    if (group) {
      query += ' WHERE s.group_name = ?';
      params.push(group);
    }
    
    query += ' ORDER BY s.name, a.date, a.hour';
    
    const rows = await allAsync(query, params);
    
    // Группируем данные по студентам и датам
    const result = {};
    
    rows.forEach(row => {
      if (!result[row.student_id]) {
        result[row.student_id] = {
          id: row.student_id,
          name: row.name,
          group: row.group_name,
          attendance: {}
        };
      }
      
      if (row.date) {
        if (!result[row.student_id].attendance[row.date]) {
          result[row.student_id].attendance[row.date] = {};
        }
        
        if (row.hour) {
          result[row.student_id].attendance[row.date][row.hour] = row.status;
        }
      }
    });
    
    res.json(Object.values(result));
  } catch (e) {
    console.error('Error getting period attendance:', e);
    res.status(500).json({ error: e.message });
  }
});

// Массовое добавление студентов
app.post('/api/students/batch', async (req, res) => {
  try {
    const { students: studentsList } = req.body;
    console.log('Batch adding students:', studentsList.length);
    
    if (!studentsList || !Array.isArray(studentsList)) {
      return res.status(400).json({ error: 'Missing or invalid students list' });
    }
    
    const results = [];
    
    for (const studentData of studentsList) {
      const { name, group, course } = studentData;
      
      try {
        const result = await runAsync(
          'INSERT INTO students (name, group_name, course) VALUES (?, ?, ?)',
          [name, group, course]
        );
        
        const inserted = await getAsync('SELECT * FROM students WHERE id = ?', [result.lastID]);
        
        const studentForClient = {
          id: inserted.id,
          name: inserted.name,
          group: inserted.group_name,
          course: inserted.course
        };
        
        results.push(studentForClient);
        io.emit('student_added', studentForClient);
        
      } catch (error) {
        console.error(`Error adding student ${name}:`, error);
        results.push({ error: error.message, student: studentData });
      }
    }
    
    res.json({ 
      success: true, 
      added: results.filter(r => !r.error).length,
      errors: results.filter(r => r.error).length,
      results 
    });
    
  } catch (e) {
    console.error('Error in batch add:', e);
    res.status(500).json({ error: e.message });
  }
});

// Получение статистики
app.get('/api/stats/daily/:date', async (req, res) => {
  try {
    const { date } = req.params;
    
    const stats = await allAsync(`
      SELECT 
        s.group_name as group,
        COUNT(DISTINCT s.id) as total_students,
        COUNT(DISTINCT CASE WHEN a.status = 'present' THEN a.student_id END) as present,
        COUNT(DISTINCT CASE WHEN a.status = 'absent' THEN a.student_id END) as absent
      FROM students s
      LEFT JOIN attendance a ON s.id = a.student_id AND a.date = ?
      GROUP BY s.group_name
    `, [date]);
    
    res.json(stats);
  } catch (e) {
    console.error('Error getting daily stats:', e);
    res.status(500).json({ error: e.message });
  }
});

// Старые API для обратной совместимости
app.get('/api/entries', async (req, res) => {
  try {
    const rows = await allAsync('SELECT * FROM entries ORDER BY id DESC');
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/entries', async (req, res) => {
  try {
    const { name, date, note } = req.body;
    const updatedAt = new Date().toISOString();
    const result = await runAsync(
      'INSERT INTO entries (name, date, note, updatedAt) VALUES (?, ?, ?, ?)',
      [name, date, note, updatedAt]
    );
    const inserted = await getAsync('SELECT * FROM entries WHERE id = ?', [result.lastID]);
    io.emit('refresh');
    res.json(inserted);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/entries/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { name, date, note } = req.body;
    const updatedAt = new Date().toISOString();
    await runAsync('UPDATE entries SET name=?, date=?, note=?, updatedAt=? WHERE id=?',
      [name, date, note, updatedAt, id]);
    const updated = await getAsync('SELECT * FROM entries WHERE id = ?', [id]);
    io.emit('refresh');
    res.json(updated);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/entries/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const row = await getAsync('SELECT * FROM entries WHERE id = ?', [id]);
    if (!row) return res.status(404).json({ error: 'Not found' });
    await runAsync('DELETE FROM entries WHERE id = ?', [id]);
    io.emit('refresh');
    res.json({ deletedId: id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    database: 'Connected'
  });
});

// Socket.IO
io.on('connection', (socket) => {
  console.log('Socket connected:', socket.id);
  
  socket.on('disconnect', () => {
    console.log('Socket disconnected:', socket.id);
  });

  socket.on('student_added', (data) => {
    console.log('Student added via socket:', data);
    socket.broadcast.emit('student_added', data);
  });

  socket.on('student_deleted', (data) => {
    console.log('Student deleted via socket:', data);
    socket.broadcast.emit('student_deleted', data);
  });

  socket.on('attendance_updated', (data) => {
    console.log('Attendance updated via socket:', data);
    socket.broadcast.emit('attendance_updated', data);
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint not found' });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('🚀 Server listening on port', PORT);
  console.log('📁 Database file:', DB_FILE);
  console.log('🔗 Health check: http://localhost:' + PORT + '/api/health');
  console.log('⏰ Почасовой учет посещаемости активирован');
});