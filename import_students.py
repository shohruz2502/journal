#!/usr/bin/env python3
"""
Скрипт для автоматического импорта студентов из Word документа
"""

import os
import sys
import requests
import time
import logging

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

def wait_for_server(max_attempts=30, delay=5):
    """Ждет пока сервер станет доступен"""
    for attempt in range(max_attempts):
        try:
            response = requests.get('http://localhost:3000/api/health', timeout=10)
            if response.status_code == 200:
                logger.info("✅ Сервер запущен и готов")
                return True
        except Exception as e:
            logger.info(f"⏳ Ожидание сервера... ({attempt + 1}/{max_attempts})")
            time.sleep(delay)
    
    logger.error("❌ Сервер не запустился в течение ожидаемого времени")
    return False

def import_students():
    logger.info("🚀 Запуск автоматического импорта студентов...")
    
    # Ждем запуск сервера
    if not wait_for_server():
        return False
    
    # Проверяем статус импорта
    try:
        response = requests.get('http://localhost:3000/api/import-status', timeout=30)
        if response.status_code == 200:
            status = response.json()
            if status.get('imported'):
                logger.info("✅ Импорт студентов уже выполнен, пропускаем")
                return True
    except Exception as e:
        logger.warning(f"⚠️ Не удалось проверить статус импорта: {e}")
    
    # Путь к Word документу
    doc_path = 'Контингент 01.11.2025.docx'
    
    if not os.path.exists(doc_path):
        logger.error(f"❌ Файл {doc_path} не найден")
        return False
    
    logger.info(f"📖 Найден файл: {doc_path} (размер: {os.path.getsize(doc_path)} bytes)")
    
    # Загружаем файл на сервер
    try:
        with open(doc_path, 'rb') as f:
            files = {'file': (os.path.basename(doc_path), f, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')}
            response = requests.post('http://localhost:3000/api/import-students', files=files, timeout=120)
        
        if response.status_code == 200:
            result = response.json()
            if result.get('success'):
                logger.info(f"✅ {result.get('message')}")
                logger.info(f"📊 Импортировано: {result.get('imported')} студентов")
                return True
            else:
                logger.error(f"❌ Ошибка импорта: {result.get('message')}")
                return False
        else:
            logger.error(f"❌ HTTP ошибка: {response.status_code} - {response.text}")
            return False
            
    except Exception as e:
        logger.error(f"❌ Ошибка при импорте: {e}")
        return False

if __name__ == "__main__":
    success = import_students()
    if success:
        logger.info("🎉 Автоматический импорт завершен успешно!")
    else:
        logger.error("💥 Автоматический импорт завершен с ошибками")
    sys.exit(0 if success else 1)
