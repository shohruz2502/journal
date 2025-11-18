#!/usr/bin/env python3
"""
Скрипт для автоматического импорта студентов из Word документа
"""

import os
import sys
import requests
import time

def import_students():
    print("🚀 Запуск автоматического импорта студентов...")
    
    # Проверяем статус импорта
    try:
        response = requests.get('http://localhost:3000/api/import-status', timeout=30)
        if response.status_code == 200:
            status = response.json()
            if status.get('imported'):
                print("✅ Импорт студентов уже выполнен, пропускаем")
                return True
    except Exception as e:
        print(f"⚠️ Не удалось проверить статус импорта: {e}")
    
    # Путь к Word документу
    doc_path = 'Контингент 01.11.2025.docx'
    
    if not os.path.exists(doc_path):
        print(f"❌ Файл {doc_path} не найден")
        return False
    
    print(f"📖 Найден файл: {doc_path}")
    
    # Ждем запуска сервера
    print("⏳ Ожидание запуска сервера...")
    time.sleep(10)
    
    # Загружаем файл на сервер
    try:
        with open(doc_path, 'rb') as f:
            files = {'file': (os.path.basename(doc_path), f, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')}
            response = requests.post('http://localhost:3000/api/import-students', files=files, timeout=60)
        
        if response.status_code == 200:
            result = response.json()
            if result.get('success'):
                print(f"✅ {result.get('message')}")
                return True
            else:
                print(f"❌ Ошибка импорта: {result.get('message')}")
                return False
        else:
            print(f"❌ HTTP ошибка: {response.status_code}")
            return False
            
    except Exception as e:
        print(f"❌ Ошибка при импорте: {e}")
        return False

if __name__ == "__main__":
    success = import_students()
    sys.exit(0 if success else 1)
