import os
import time
import json
import unittest
from urllib.request import urlopen

from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC


BASE_URL = "http://localhost:3000"

EVIDENCIAS = os.path.join(
    os.path.dirname(os.path.abspath(__file__)),
    "evidencias"
)

os.makedirs(EVIDENCIAS, exist_ok=True)


class TestRaceSyncDistribuido(unittest.TestCase):

    def crear_driver(self):
        options = webdriver.ChromeOptions()
        options.add_argument("--start-maximized")
        return webdriver.Chrome(options=options)

    def screenshot(self, driver, nombre):
        ruta = os.path.join(EVIDENCIAS, nombre)
        driver.save_screenshot(ruta)
        print(f"Evidencia guardada: {ruta}")

    def ingresar_jugador(self, driver, nombre_jugador, circuito_id, evidencia_nombre):
        wait = WebDriverWait(driver, 15)

        driver.get(BASE_URL)

        # Pantalla inicial
        wait.until(
            EC.element_to_be_clickable((By.CSS_SELECTOR, "#ts .ps"))
        ).click()

        # Elegir circuito
        wait.until(
            EC.element_to_be_clickable((By.ID, circuito_id))
        ).click()

        # Confirmar circuito
        wait.until(
            EC.element_to_be_clickable((By.ID, "cgb"))
        ).click()

        # Escribir nombre del piloto
        caja_nombre = wait.until(
            EC.visibility_of_element_located((By.ID, "ni"))
        )
        caja_nombre.clear()
        caja_nombre.send_keys(nombre_jugador)

        # Ir al grid
        wait.until(
            EC.element_to_be_clickable((By.CSS_SELECTOR, "#sel button.gb"))
        ).click()

        # Esperar HUD
        hud = wait.until(
            EC.visibility_of_element_located((By.ID, "hud"))
        )

        self.assertTrue(hud.is_displayed())

        # Esperar un poco para estabilizar la vista
        time.sleep(2)

        self.screenshot(driver, evidencia_nombre)

    def test_01_dos_jugadores_simultaneos(self):
        driver1 = self.crear_driver()
        driver2 = self.crear_driver()

        try:
            # Jugador 1
            self.ingresar_jugador(
                driver1,
                "Piloto_A",
                "c0",
                "06_jugador_A_hud.png"
            )

            # Jugador 2
            self.ingresar_jugador(
                driver2,
                "Piloto_B",
                "c1",
                "07_jugador_B_hud.png"
            )

            # Consultar estado distribuido del gateway
            with urlopen(BASE_URL + "/health") as response:
                health = json.loads(response.read().decode("utf-8"))

            print("Respuesta /health:", health)

            self.assertEqual(health.get("status"), "ok")
            self.assertGreaterEqual(health.get("players", 0), 2)
            self.assertIn("vectorClock", health)

            print("PASS - El gateway sigue operativo")
            print("PASS - Hay 2 o más jugadores conectados")
            print("PASS - El reloj vectorial está presente")

        finally:
            time.sleep(2)
            driver1.quit()
            driver2.quit()


if __name__ == "__main__":
    unittest.main(verbosity=2)