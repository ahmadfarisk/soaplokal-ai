import sqlite3


connection = sqlite3.connect('lai012.db')

cursor = connection.cursor()



command1 = "SELECT * FROM models"

cursor.execute(command1)

results = cursor.fetchall()
print(results)